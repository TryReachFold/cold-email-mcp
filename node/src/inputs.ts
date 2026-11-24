import { DEFAULT_BASE_URL, EXIT_FAILURE, PROGRAM_NAME, CliError, UsageError, type Io } from "./base.js";

/** Same shape checks as the API, so bad input fails before any request is sent. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
/** One unambiguous number syntax in both packages (no hex, underscores, NaN). */
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();
export const isEmail = (email: string): boolean => EMAIL_RE.test(email);

/** Same cleanup as the API: scheme, path and case are dropped. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
}
export const isDomain = (domain: string): boolean => DOMAIN_RE.test(domain) && domain.length <= 253;

export function parseNumber(flag: string, raw: string): number {
  const text = raw.trim();
  if (!NUMBER_RE.test(text)) throw new UsageError(`--${flag} must be a number, got "${raw}".`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new UsageError(`--${flag} must be a finite number, got "${raw}".`);
  return value;
}

const READ_REASONS: Readonly<Record<string, string>> = {
  ENOENT: "no such file or directory",
  EISDIR: "is a directory",
  EACCES: "permission denied",
  EPERM: "permission denied",
};

/** Reads a text file as UTF-8 text with LF line endings and no BOM. */
export function readText(io: Io, path: string): string {
  try {
    return io.readTextFile(path).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new UsageError(`Cannot read file "${path}": ${READ_REASONS[code] ?? "read error"}.`);
  }
}

export interface InputLine {
  readonly number: number;
  readonly text: string;
}

/** Non-empty trimmed lines with their 1-based numbers. */
export function parseLines(text: string): InputLine[] {
  return text.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    return line ? [{ number: index + 1, text: line }] : [];
  });
}

export interface CollectedItems {
  /** Normalized, client-side valid values in input order. */
  readonly values: string[];
  /** Lines of the --file that were skipped as invalid. */
  readonly skipped: readonly InputLine[];
}

/**
 * Items from argv and/or --file. A bad argv item is a usage error (exit 2);
 * a bad line in a file is skipped with a warning and reported through exit code 1.
 */
export function collectItems(source: {
  readonly io: Io;
  readonly command: string;
  readonly kind: "domain" | "email";
  readonly argv: readonly string[];
  readonly file: string | undefined;
  readonly normalize: (raw: string) => string;
  readonly isValid: (value: string) => boolean;
}): CollectedItems {
  const { normalize, isValid, kind } = source;
  const values: string[] = [];
  for (const raw of source.argv) {
    const value = normalize(raw);
    if (!isValid(value)) {
      throw new UsageError(`Not a valid ${kind}: "${raw.trim()}".`);
    }
    values.push(value);
  }

  const skipped: InputLine[] = [];
  if (source.file !== undefined) {
    const name = source.file === "-" ? "stdin" : source.file;
    for (const line of parseLines(readText(source.io, source.file))) {
      const value = normalize(line.text);
      if (isValid(value)) {
        values.push(value);
      } else {
        skipped.push(line);
        source.io.stderr(`${name}, line ${line.number}: skipped, not a valid ${kind}: "${line.text}"\n`);
      }
    }
  }

  if (values.length === 0) {
    if (skipped.length > 0) {
      throw new CliError(
        `No valid ${kind} to check: all ${skipped.length} line(s) of "${source.file}" were skipped.`,
      );
    }
    throw new UsageError(
      `Provide at least one ${kind} or pass --file <path>. Run "${PROGRAM_NAME} ${source.command} --help".`,
    );
  }
  return { values, skipped };
}

export interface EmailContent {
  readonly subject: string;
  readonly body: string;
}

function stripFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * A positional file is "subject", one blank line, then the body.
 * Without the blank line the whole file is the body.
 */
export function splitEmailFile(text: string): EmailContent {
  const match = /^([^\n]*)\n[ \t]*\n([\s\S]*)$/.exec(text);
  if (match === null) return { subject: "", body: stripFinalNewline(text) };
  return { subject: (match[1] ?? "").trim(), body: stripFinalNewline(match[2] ?? "") };
}

export const bodyFromFile = (text: string): string => stripFinalNewline(text);

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Validates --base-url. Plain http is allowed only on the local machine. */
export function normalizeBaseUrl(raw: string | undefined): string {
  const given = raw?.trim();
  const value = given && given.length > 0 ? given : DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`--base-url "${value}" is not a valid URL.`);
  }
  const local = url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new UsageError(`--base-url must use https (http is allowed only for localhost): "${value}".`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new UsageError(
      `--base-url must be an origin without path, query or credentials, e.g. "${DEFAULT_BASE_URL}".`,
    );
  }
  return url.origin;
}

