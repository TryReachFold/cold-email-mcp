import {
  EXIT_FAILURE,
  EXIT_OK,
  ApiError,
  UsageError,
  asObject,
  oneLine,
  renderTable,
  type Io,
  type JsonObject,
} from "./base.js";
import { getFlag, getString, type OptionName, type OptionValues } from "./args.js";
import {
  createApiContext,
  describeFailure,
  requestEach,
  type HttpResult,
  type HttpSettings,
} from "./http.js";
import {
  bodyFromFile,
  collectItems,
  isDomain,
  isEmail,
  normalizeDomain,
  normalizeEmail,
  parseNumber,
  readText,
  splitEmailFile,
} from "./inputs.js";
import {
  PLANS,
  ROI_INPUTS,
  computeRoi,
  defaultRoiInputs,
  normalizeName,
  permute,
  renderRoi,
  roiToJson,
  type Plan,
  type RoiInputs,
} from "./local.js";

export interface CommandArgs {
  readonly options: OptionValues;
  readonly positionals: readonly string[];
}

export type Runner = (
  args: CommandArgs,
  io: Io,
  settings: HttpSettings | undefined,
) => Promise<number>;

function jsonString(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/** Exit code 1 when anything was skipped or failed; the summary itself is service output. */
function finish(io: Io, failed: number, skipped: number): number {
  if (failed === 0 && skipped === 0) return EXIT_OK;
  io.stderr(`Finished with problems: ${failed} failed, ${skipped} skipped as invalid.\n`);
  return EXIT_FAILURE;
}

function verifyRow(email: string, data: unknown): string[] {
  const record: JsonObject = asObject(data) ?? {};
  const text = (key: string): string => (typeof record[key] === "string" ? oneLine(String(record[key])) : "");
  const flags = jsonString(record.flags);
  return [email, text("status") || "unknown", text("reason"), flags.length > 0 ? flags.join(", ") : "-"];
}

/** The audit output relies on domain, score and issues only; every other field is optional. */
function renderAudit(domain: string, data: unknown): string {
  const record: JsonObject = asObject(data) ?? {};
  const name = typeof record.domain === "string" && record.domain ? record.domain : domain;
  const score = typeof record.score === "number" ? record.score : "n/a";
  const lines = [`${name}: score ${score}/100`];
  if (!Array.isArray(record.issues)) {
    lines.push("  Issues: not reported by the server");
  } else {
    const issues = record.issues.map(asObject).filter(isDefined);
    if (issues.length === 0) {
      lines.push("  No issues found");
    } else {
      lines.push("  Issues:");
      for (const issue of issues) {
        const field = (key: string): string => oneLine(String(issue[key] ?? "?"));
        lines.push(`    [${field("severity")}] ${field("id")}: ${field("fix")}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** What the tool does not check is service information: it goes to stderr. */
function auditCaveats(data: unknown): string[] {
  const record = asObject(data);
  const notChecked = jsonString(record?.not_checked);
  const notes = jsonString(record?.notes);
  return [
    notChecked.length > 0 ? `Not checked by this tool: ${notChecked.join("; ")}` : "",
    notes.length > 0 ? `Notes: ${notes.join("; ")}` : "",
  ].filter((line) => line.length > 0);
}

function renderScore(data: unknown): string {
  const record: JsonObject = asObject(data) ?? {};
  const score = typeof record.spam_score === "number" ? String(record.spam_score) : "n/a";
  const verdict = typeof record.verdict === "string" ? record.verdict : "unknown";
  const triggers = Array.isArray(record.triggers) ? record.triggers.map(asObject).filter(isDefined) : [];
  const lines = [`Spam score: ${score}/100 (${verdict})`, "Triggers:"];
  if (triggers.length === 0) lines.push("  none");
  for (const trigger of triggers) {
    const points = typeof trigger.points === "number" ? String(trigger.points) : "?";
    lines.push(`  ${points.padStart(3)}  ${oneLine(String(trigger.phrase ?? ""))}`);
  }
  if (typeof record.checked_chars === "number") lines.push(`Checked ${record.checked_chars} characters`);
  return lines.join("\n") + "\n";
}

export async function runVerify(
  { options, positionals }: CommandArgs,
  io: Io,
  settings: HttpSettings | undefined,
): Promise<number> {
  const items = collectItems({
    io,
    command: "verify",
    kind: "email",
    argv: positionals,
    file: getString(options, "file"),
    normalize: normalizeEmail,
    isValid: isEmail,
  });
  const ctx = createApiContext(options, io, settings);
  const rows: string[][] = [];
  let failed = 0;
  try {
    for await (const event of requestEach(
      ctx,
      "/api/tools/verify-email",
      items.values,
      (email) => ({ email }),
      "Checking",
    )) {
      if (event.type === "item-error") {
        failed += 1;
        io.stderr(`FAILED ${event.item}: ${event.error.message}\n`);
        continue;
      }
      if (ctx.json) io.stdout(`${event.raw}\n`);
      else rows.push(verifyRow(event.item, event.data));
    }
  } finally {
    // Results collected so far stay readable when a later request aborts the batch.
    if (!ctx.json && rows.length > 0) io.stdout(renderTable(["EMAIL", "STATUS", "REASON", "FLAGS"], rows));
  }
  return finish(io, failed, items.skipped.length);
}

export async function runAudit(
  { options, positionals }: CommandArgs,
  io: Io,
  settings: HttpSettings | undefined,
): Promise<number> {
  const items = collectItems({
    io,
    command: "audit",
    kind: "domain",
    argv: positionals,
    file: getString(options, "file"),
    normalize: normalizeDomain,
    isValid: isDomain,
  });
  const ctx = createApiContext(options, io, settings);
  let failed = 0;
  for await (const event of requestEach(
    ctx,
    "/api/tools/dns-audit",
    items.values,
    (domain) => ({ domain }),
    "Auditing",
  )) {
    if (event.type === "item-error") {
      failed += 1;
      io.stderr(`FAILED ${event.item}: ${event.error.message}\n`);
      continue;
    }
    if (ctx.json) io.stdout(`${event.raw}\n`);
    else io.stdout(`${renderAudit(event.item, event.data)}${items.values.length > 1 ? "\n" : ""}`);
    for (const line of auditCaveats(event.data)) io.stderr(`${line}\n`);
  }
  return finish(io, failed, items.skipped.length);
}

export async function runScore(
  { options, positionals }: CommandArgs,
  io: Io,
  settings: HttpSettings | undefined,
): Promise<number> {
  const bodyFile = getString(options, "body-file");
  const subjectOption = getString(options, "subject");
  const [file, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError("score takes one <file>, or --subject with --body-file.");
  if (file !== undefined && (bodyFile !== undefined || subjectOption !== undefined)) {
    throw new UsageError("Pass either a <file> or --subject/--body-file, not both.");
  }
  const content =
    file !== undefined
      ? splitEmailFile(readText(io, file))
      : {
          subject: (subjectOption ?? "").trim(),
          body: bodyFile === undefined ? "" : bodyFromFile(readText(io, bodyFile)),
        };
  if (content.subject.length === 0 && content.body.trim().length === 0) {
    throw new UsageError("Nothing to score: provide --subject and/or --body-file, or a <file>.");
  }

  const ctx = createApiContext(options, io, settings);
  const result: HttpResult = await ctx.client.post("/api/tools/spam-score", content);
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(describeFailure(result, ctx.host), result.status);
  }
  if (ctx.json) io.stdout(`${result.body.trim()}\n`);
  else io.stdout(renderScore(JSON.parse(result.body)));
  return EXIT_OK;
}

export async function runPermute({ options }: CommandArgs, io: Io): Promise<number> {
  const first = getString(options, "first");
  const last = getString(options, "last");
  if (first === undefined || last === undefined) {
    throw new UsageError('--first and --last are required. Run "cold-email-mcp permute --help".');
  }
  for (const [flag, value] of [
    ["--first", first],
    ["--last", last],
  ] as const) {
    if (normalizeName(value).length === 0) {
      throw new UsageError(
        `${flag} "${value}" has no letters left after cleanup: only Latin and Cyrillic letters are kept.`,
      );
    }
  }
  const result = permute(first, last, getString(options, "domain") ?? "");
  io.stdout(
    getFlag(options, "json")
      ? `${JSON.stringify(result)}\n`
      : `${result.map((item) => item.value).join("\n")}\n`,
  );
  return EXIT_OK;
}

function parseRoiOptions(options: OptionValues): { inputs: RoiInputs; warnings: string[] } {
  const inputs = defaultRoiInputs();
  const warnings: string[] = [];
  for (const spec of ROI_INPUTS) {
    const raw = getString(options, spec.flag as OptionName);
    if (raw === undefined) continue;
    const value = parseNumber(spec.flag, raw);
    const flag = `--${spec.flag}`;
    if (spec.positive ? value <= 0 : value < 0) {
      throw new UsageError(`${flag} must be ${spec.positive ? "greater than" : "at least"} 0, got ${raw}.`);
    }
    if (spec.integer && !Number.isInteger(value)) {
      throw new UsageError(`${flag} must be a whole number, got ${raw}.`);
    }
    if (spec.unit === "%" && value > 100) {
      throw new UsageError(`${flag} is a percentage and cannot exceed 100, got ${raw}.`);
    }
    if (value < spec.min || value > spec.max) {
      warnings.push(
        `Warning: ${flag} ${raw} is outside the calculator range ${spec.min} to ${spec.max}; the estimate may be unrealistic.`,
      );
    }
    inputs[spec.field] = value;
  }
  const planName = getString(options, "plan");
  if (planName !== undefined) {
    const plan: Plan | undefined = PLANS.find((candidate) => candidate.id === planName.trim().toLowerCase());
    if (plan === undefined) {
      throw new UsageError(`--plan must be one of ${PLANS.map((candidate) => candidate.id).join(", ")}, got "${planName}".`);
    }
    inputs.plan = plan;
  }
  return { inputs, warnings };
}

export async function runRoi({ options }: CommandArgs, io: Io): Promise<number> {
  const { inputs, warnings } = parseRoiOptions(options);
  for (const warning of warnings) io.stderr(`${warning}\n`);
  const model = computeRoi(inputs);
  io.stdout(getFlag(options, "json") ? roiToJson(inputs, model) : renderRoi(inputs, model));
  return EXIT_OK;
}
