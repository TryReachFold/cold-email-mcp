#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXIT_FAILURE,
  EXIT_OK,
  PROGRAM_NAME,
  VERSION,
  BANNER,
  CliError,
  firstLine,
  shouldShowBanner,
  systemIo,
  type Io,
} from "./base.js";
import {
  getFlag,
  parseCommandLine,
  renderCommandHelp,
  renderHelp,
  type CommandName,
} from "./args.js";
import {
  runAudit,
  runPermute,
  runRoi,
  runScore,
  runVerify,
  type CommandArgs,
  type Runner,
} from "./commands.js";
import type { HttpSettings } from "./http.js";

const RUNNERS: Record<CommandName, Runner> = {
  verify: runVerify,
  audit: runAudit,
  score: runScore,
  permute: runPermute,
  roi: runRoi,
};

/** Runs one invocation and returns the exit code. Throws CliError for anything unexpected. */
export async function runCli(
  argv: readonly string[],
  io: Io = systemIo(),
  settings?: HttpSettings,
): Promise<number> {
  const invocation = parseCommandLine(argv);
  if (invocation.action === "version") {
    io.stdout(`${PROGRAM_NAME} ${VERSION}\n`);
    return EXIT_OK;
  }
  if (invocation.action === "help") {
    io.stdout(invocation.command === undefined ? renderHelp() : renderCommandHelp(invocation.command));
    return EXIT_OK;
  }
  const { command, options, positionals } = invocation;
  const exitCode = await RUNNERS[command.name]({ options, positionals } satisfies CommandArgs, io, settings);
  // One factual line after the result; --no-banner or OUTBOUND_UTILS_NO_BANNER=1 switches it off.
  if (shouldShowBanner(getFlag(options, "no-banner"), io.env)) io.stderr(`${BANNER}\n`);
  return exitCode;
}

export async function main(argv: readonly string[], io?: Io, settings?: HttpSettings): Promise<number> {
  try {
    return await runCli(argv, io, settings);
  } catch (err) {
    const output = io ?? systemIo();
    if (err instanceof CliError) {
      output.stderr(`Error: ${err.message}\n`);
      return err.exitCode;
    }
    output.stderr(`Unexpected error: ${firstLine(err)}\n`);
    return EXIT_FAILURE;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const normalize = (path: string): string => {
    const real = realpathSync(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  try {
    return normalize(entry) === normalize(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // A closed pipe (`| head`) is not an error worth a stack trace.
  const onPipeError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") process.exit(EXIT_OK);
  };
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`Unexpected error: ${firstLine(err)}\n`);
      process.exitCode = EXIT_FAILURE;
    },
  );
}
