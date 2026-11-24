import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const PROGRAM_NAME = "cold-email-mcp";
export const DEFAULT_BASE_URL = "https://tryreachfold.com";
/** package.json sits one level up from dist/, two levels up from the test build. */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      return (require(relative) as { version: string }).version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

export const VERSION: string = readVersion();

/** Process exit codes shared by every command. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1; // network or API error, skipped input lines
export const EXIT_USAGE = 2; // invalid arguments

/** An error the CLI reports to the user as one line, without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_FAILURE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** The command line itself is wrong: unknown option, bad value, missing input. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
    this.name = "UsageError";
  }
}

/** The tool API answered with a status that retrying will not fix. */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, EXIT_FAILURE);
    this.name = "ApiError";
  }
}

export const EXIT_CODES_HELP =
  "Exit codes: 0 = success, 1 = network or API error (or skipped input lines), 2 = invalid arguments.";

/** Facts only: what the product is and where the waitlist is. */
export const BANNER =
  "Reachfold — AI SDR with human approval. Waitlist: " +
  "https://tryreachfold.com/?utm_source=cli&utm_medium=referral&utm_campaign=waitlist-launch";

export function shouldShowBanner(
  noBannerFlag: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (noBannerFlag) return false;
  const value = env.OUTBOUND_UTILS_NO_BANNER?.trim().toLowerCase();
  return value !== "1" && value !== "true";
}

export function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n", 1)[0] ?? "").trim();
}

/** All I/O of the CLI, injectable so tests never touch the real streams. */
export interface Io {
  /** Machine-readable output: nothing but results goes here. */
  stdout(text: string): void;
  /** Service output: warnings, progress, retry notices, the closing banner. */
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** Read a UTF-8 text file ("-" = stdin). Throws on failure. */
  readTextFile(path: string): string;
}

export function systemIo(): Io {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    readTextFile(path: string): string {
      if (path !== "-") return readFileSync(path, "utf8");
      if (process.stdin.isTTY) {
        throw new UsageError('"-" reads from stdin, but stdin is a terminal. Pipe a file in instead.');
      }
      return readFileSync(0, "utf8"); // fd 0 = stdin
    },
  };
}

/** A JSON object as the API returns it: every field is optional at run time. */
export type JsonObject = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Server text may contain line breaks; one table cell is always one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Left-aligns columns with two spaces between them (rows may differ in length). */
export function alignRows(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd(),
  );
}

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [...alignRows([headers]), ...alignRows(rows)].join("\n") + "\n";
}

// Number formats of the web calculator, so both show the same digits.
const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCentsFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const usd = (value: number): string => usdFormat.format(value);
export const usdCents = (value: number): string => usdCentsFormat.format(value);
export const int = (value: number): string => intFormat.format(value);
export const jsRound = Math.round;
export const toFixed = (value: number, digits: number): string => value.toFixed(digits);
