import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { DEFAULT_BASE_URL, EXIT_CODES_HELP, PROGRAM_NAME, firstLine, UsageError } from "./base.js";
import { ROI_FLAGS, roiOptionHelp } from "./local.js";

export type CommandName = "verify" | "audit" | "score" | "permute" | "roi";
type OptionType = "boolean" | "string";

export type OptionName =
  | "base-url"
  | "body-file"
  | "domain"
  | "file"
  | "first"
  | "json"
  | "last"
  | "no-banner"
  | "subject"
  | "help"
  | "version"
  | (typeof ROI_FLAGS)[number];

/** Type of every option the CLI knows, so one flag is never parsed two ways. */
const OPTION_TYPES: Record<OptionName, OptionType> = {
  "base-url": "string",
  "body-file": "string",
  domain: "string",
  file: "string",
  first: "string",
  json: "boolean",
  last: "string",
  "no-banner": "boolean",
  subject: "string",
  help: "boolean",
  version: "boolean",
  ...(Object.fromEntries(ROI_FLAGS.map((flag) => [flag, "string"])) as Record<(typeof ROI_FLAGS)[number], "string">),
};

const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "base-url": "<url>",
  "body-file": "<path>",
  domain: "<domain>",
  file: "<path>",
  first: "<name>",
  last: "<name>",
  plan: "<name>",
  subject: "<text>",
};

export type OptionValues = Partial<Record<OptionName, string | boolean>>;

export function getString(options: OptionValues, name: OptionName): string | undefined {
  const value = options[name];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Option "--${name}" was declared as text but parsed as ${typeof value}.`);
  }
  return value;
}

export function getFlag(options: OptionValues, name: OptionName): boolean {
  return options[name] === true;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
  /** Positional part of the usage line. */
  readonly usage: string;
  readonly argumentHelp: readonly string[];
  readonly description: readonly string[];
  /** Option name → help text for this command. */
  readonly options: Readonly<Record<string, string>>;
}

const SHARED_OPTIONS = {
  json: "Print the raw JSON response to stdout, one JSON document per line",
  "no-banner": "Skip the closing waitlist line (or set OUTBOUND_UTILS_NO_BANNER=1)",
} as const;

const NETWORK_OPTIONS = {
  "base-url": `API base URL (default: ${DEFAULT_BASE_URL})`,
  ...SHARED_OPTIONS,
} as const;

const LOCAL_OPTIONS = {
  json: "Print the result as JSON to stdout",
  "no-banner": SHARED_OPTIONS["no-banner"],
} as const;

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "verify",
    summary: "Check the syntax, domain and MX records of email addresses.",
    usage: "[<email...>]",
    argumentHelp: ["<email...>   One or more email addresses"],
    description: [
      "DNS-stage check only: there is no SMTP handshake, so an existing mailbox is",
      "not confirmed and catch-all domains are not detected.",
    ],
    options: {
      file: 'Read one email per line from <path> ("-" = stdin); adds to <email...>',
      ...NETWORK_OPTIONS,
    },
  },
  {
    name: "audit",
    summary: "Grade the email DNS setup of a domain (SPF, DKIM, DMARC, MX).",
    usage: "[<domain...>]",
    argumentHelp: ["<domain...>   One or more domains, e.g. acme.com"],
    description: [
      "Reads DNS records only: no sending-IP blacklist check, no inbox placement test.",
      '"DKIM not found" means the selector is not on the checked list, not that DKIM is unset.',
    ],
    options: {
      file: 'Read one domain per line from <path> ("-" = stdin); adds to <domain...>',
      ...NETWORK_OPTIONS,
    },
  },
  {
    name: "score",
    summary: "Score an email subject and body for spam-trigger words.",
    usage: "[<file>]",
    argumentHelp: ["<file>   Text file: subject, one blank line, body. Without the blank line the whole file is the body."],
    description: [
      "A deterministic word and pattern heuristic. It is not SpamAssassin and does not",
      "predict the filters of Gmail or Outlook.",
    ],
    options: {
      subject: "Email subject line",
      "body-file": 'Read the email body from <path> ("-" = stdin)',
      ...NETWORK_OPTIONS,
    },
  },
  {
    name: "permute",
    summary: "Generate corporate email patterns from a first and last name (offline).",
    usage: "",
    argumentHelp: [],
    description: [
      "Cyrillic names are transliterated. The patterns are guesses, not verified addresses.",
      "Without --domain only the local parts are printed.",
    ],
    options: {
      first: "First name (required)",
      last: "Last name (required)",
      domain: "Company domain, e.g. acme.com",
      ...LOCAL_OPTIONS,
    },
  },
  {
    name: "roi",
    summary: "Estimate what a meetings-per-month target costs, three ways (offline).",
    usage: "",
    argumentHelp: [],
    description: [
      "Arithmetic on your own inputs: an in-house SDR, a lead agency and Reachfold.",
      "Estimates only, not a quote.",
    ],
    options: { ...roiOptionHelp(), ...LOCAL_OPTIONS },
  },
];

export type Invocation =
  | { readonly action: "help"; readonly command: CommandSpec | undefined }
  | { readonly action: "version" }
  | {
      readonly action: "run";
      readonly command: CommandSpec;
      readonly options: OptionValues;
      readonly positionals: readonly string[];
    };

/** The slice of parseArgs tokens the CLI relies on (the official type names vary by Node version). */
interface Token {
  readonly kind: string;
  readonly name?: string;
  readonly rawName?: string;
  readonly index: number;
  readonly value?: string;
}

type OptionToken = Token & { readonly name: string; readonly rawName: string };

const isOptionToken = (token: Token): token is OptionToken =>
  token.kind !== "positional" && token.kind !== "option-terminator";

/** Loose pass over every known option: only used to find the command and the flags used. */
function tokenize(args: readonly string[]): Token[] {
  const options: ParseArgsOptionsConfig = Object.fromEntries(
    Object.entries(OPTION_TYPES).map(([name, type]) => [name, { type }]),
  );
  try {
    const { tokens } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: false,
      tokens: true,
    }) as unknown as { tokens: Token[] };
    return tokens;
  } catch (err) {
    throw new UsageError(`Invalid command line: ${firstLine(err)}`);
  }
}

function describeParseError(err: unknown, spec: CommandSpec): string {
  const message = firstLine(err);
  const hint = `Run "${PROGRAM_NAME} ${spec.name} --help".`;
  const name = /Option '([^']+)'/.exec(message)?.[1] ?? "unknown";
  if (message.includes("argument missing")) return `Option "${name}" requires a value. ${hint}`;
  if (message.includes("does not take an argument")) return `Option "${name}" does not take a value. ${hint}`;
  return `Invalid options: ${message} ${hint}`;
}

export function parseCommandLine(args: readonly string[]): Invocation {
  const tokens = tokenize(args);
  const optionTokens = tokens.filter(isOptionToken);
  const positionals = tokens.filter((token) => token.kind === "positional");
  const commandToken = positionals[0];
  const spec = COMMAND_SPECS.find((candidate) => candidate.name === commandToken?.value);

  // --help and --version act the moment they are read, unless an unknown option comes first.
  const unknown = optionTokens.find((token) => !(token.name in OPTION_TYPES));
  const builtIn = optionTokens.find((token) => token.name === "help" || token.name === "version");
  if (builtIn !== undefined && (unknown === undefined || builtIn.index < unknown.index)) {
    const beforeCommand = commandToken === undefined || builtIn.index < commandToken.index;
    if (builtIn.name === "help") return { action: "help", command: beforeCommand ? undefined : spec };
    if (beforeCommand) return { action: "version" };
  }
  if (unknown !== undefined) {
    throw new UsageError(`Unknown option "${unknown.rawName}". Run "${PROGRAM_NAME} --help".`);
  }
  if (commandToken === undefined) {
    throw new UsageError(`Missing command. Run "${PROGRAM_NAME} --help" to list the commands.`);
  }
  if (spec === undefined) {
    throw new UsageError(`Unknown command "${commandToken.value}". Run "${PROGRAM_NAME} --help" to list the commands.`);
  }
  for (const token of optionTokens) {
    if (!(token.name in spec.options)) {
      throw new UsageError(
        `Option "${token.rawName}" is not supported by "${spec.name}". Run "${PROGRAM_NAME} ${spec.name} --help".`,
      );
    }
  }

  // Strict pass with only this command's options: catches missing or extra values.
  let values: OptionValues;
  try {
    const options: ParseArgsOptionsConfig = Object.fromEntries(
      Object.keys(spec.options).map((name) => [name, { type: OPTION_TYPES[name as OptionName] }]),
    );
    values = parseArgs({ args: [...args], options, allowPositionals: true, strict: true }).values as OptionValues;
  } catch (err) {
    throw new UsageError(describeParseError(err, spec));
  }
  return {
    action: "run",
    command: spec,
    options: values,
    positionals: positionals.slice(1).map((token) => token.value ?? ""),
  };
}

function optionLines(spec: CommandSpec): string[] {
  const names = [...Object.keys(spec.options), "help"];
  const rows = names.map((name) => {
    const type = OPTION_TYPES[name as OptionName];
    const argument = type === "boolean" ? "" : ` ${PLACEHOLDERS[name] ?? (ROI_FLAGS.includes(name as (typeof ROI_FLAGS)[number]) ? "<n>" : "<value>")}`;
    return [`--${name}${argument}`, spec.options[name] ?? "Show this help"];
  });
  return alignOptionRows(rows);
}

function alignOptionRows(rows: readonly (readonly string[])[]): string[] {
  const width = Math.max(...rows.map((row) => (row[0] ?? "").length));
  return rows.map((row) => `  ${(row[0] ?? "").padEnd(width)}  ${row[1] ?? ""}`);
}

export function renderHelp(): string {
  const summary = COMMAND_SPECS.map((spec) => `  ${spec.name.padEnd(9)}  ${spec.summary}`);
  return [
    `${PROGRAM_NAME} <command> [options]`,
    "",
    "Reachfold free outbound tools from the terminal. No sign-up, no API key.",
    "",
    "Commands:",
    ...summary,
    "",
    "Options:",
    ...alignOptionRows([
      ["--base-url <url>", `API base URL for verify, audit and score (default: ${DEFAULT_BASE_URL})`],
      ["--json", SHARED_OPTIONS.json],
      ["--no-banner", SHARED_OPTIONS["no-banner"]],
      ["--help", "Show this help"],
      ["--version", "Print the CLI version"],
    ]),
    "",
    `Run "${PROGRAM_NAME} <command> --help" for the options of one command.`,
    EXIT_CODES_HELP,
    "",
  ].join("\n");
}

export function renderCommandHelp(spec: CommandSpec): string {
  const usage = `${PROGRAM_NAME} ${spec.name}${spec.usage ? ` ${spec.usage}` : ""} [options]`;
  return [
    usage,
    "",
    spec.summary,
    "",
    ...(spec.argumentHelp.length > 0 ? ["Arguments:", ...spec.argumentHelp.map((line) => `  ${line}`), ""] : []),
    "Options:",
    ...optionLines(spec),
    "",
    ...spec.description,
    "",
    EXIT_CODES_HELP,
    "",
  ].join("\n");
}
