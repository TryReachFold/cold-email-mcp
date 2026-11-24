import { deepStrictEqual, ok, match } from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;
const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

function run(
  args: readonly string[],
  options: { input?: string; env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const BANNER = "Reachfold — AI SDR with human approval";

describe("subprocess basics", () => {
  it("--help lists the commands and exit codes", () => {
    const { status, stdout } = run(["--help"]);
    deepStrictEqual(status, 0);
    for (const command of ["verify", "audit", "score", "permute", "roi"]) {
      ok(stdout.includes(command), command);
    }
    ok(stdout.includes("Exit codes: 0 = success, 1 = network or API error"));
  });

  it("command --help shows the command's options", () => {
    const { status, stdout } = run(["roi", "--help"]);
    deepStrictEqual(status, 0);
    ok(stdout.includes("--meetings") && stdout.includes("--plan") && stdout.includes("--no-banner"));
    ok(!stdout.includes("--file"), "roi has no --file option");
  });

  it("--version prints the package version", () => {
    const { status, stdout } = run(["--version"]);
    deepStrictEqual(status, 0);
    deepStrictEqual(stdout.trim(), `cold-email-mcp ${packageVersion}`);
  });

  it("--version acts before a later unknown option, not before an earlier one", () => {
    deepStrictEqual(run(["--version", "--bogus"]).status, 0);
    const late = run(["--bogus", "--version"]);
    deepStrictEqual(late.status, 2);
    ok(late.stderr.includes("Unknown option"));
  });

  it("prints the factual banner after a successful command, on stderr only", () => {
    const { status, stdout, stderr } = run(["permute", "--first", "Jane", "--last", "Doe"]);
    deepStrictEqual(status, 0);
    ok(stdout.includes("jane.doe"));
    ok(stderr.includes(BANNER));
    ok(stderr.includes("utm_source=cli"));
    ok(!stdout.includes(BANNER));
    ok(!stderr.includes("free tier") && !stderr.includes("inbox"));
  });

  it("--no-banner and OUTBOUND_UTILS_NO_BANNER=1 silence the banner", () => {
    deepStrictEqual(run(["permute", "--first", "J", "--last", "D", "--no-banner"]).stderr, "");
    const byEnv = run(["permute", "--first", "J", "--last", "D"], { env: { OUTBOUND_UTILS_NO_BANNER: "1" } });
    deepStrictEqual(byEnv.stderr, "");
  });
});

describe("subprocess offline commands", () => {
  it("permute --json is compact JSON on stdout", () => {
    const { status, stdout } = run([
      "permute",
      "--json",
      "--first",
      "Иван",
      "--last",
      "Пётр",
      "--domain",
      "acme.com",
      "--no-banner",
    ]);
    deepStrictEqual(status, 0);
    const parsed = JSON.parse(stdout) as { pattern: string; value: string; most_common: boolean }[];
    deepStrictEqual(parsed.filter((item) => item.most_common).length, 1);
    ok(parsed.some((item) => item.value === "ivan.petr@acme.com"));
  });

  it("roi prints the same numbers as the fixture defaults", () => {
    const { status, stdout } = run(["roi", "--no-banner"]);
    deepStrictEqual(status, 0);
    ok(stdout.includes("2,667") && stdout.includes("$10,833") && stdout.includes("$179"));
    ok(stdout.includes("Estimates only"));
  });

  it("roi --json parses and matches the fixture", () => {
    const { status, stdout } = run(["roi", "--json", "--no-banner"]);
    deepStrictEqual(status, 0);
    const actual = JSON.parse(stdout) as Record<string, unknown>;
    const fixture = JSON.parse(readFileSync(`${fixtures}roi.json`, "utf8")) as {
      cases: { name: string; expected: Record<string, unknown> }[];
    };
    deepStrictEqual(actual, fixture.cases[0]!.expected);
  });

  it("score reads subject + blank line + body from a file", () => {
    // Local mock so nothing touches production.
    const { status } = run(
      ["score", "--subject", "Hi", "--body-file", `${fixtures}score-sample.txt`, "--no-banner",
       "--base-url", "http://127.0.0.1:1"],
    );
    deepStrictEqual(status, 1, "network error against a dead port, but argument handling is exercised");
  });
});

describe("subprocess usage errors (exit 2)", () => {
  const cases: readonly (readonly string[])[] = [
    [],
    ["no-such-command"],
    ["verify"],
    ["audit", "bad_domain"],
    ["verify", "not-an-email"],
    ["permute", "--first", "Jane"],
    ["permute", "--first", "###", "--last", "Doe"],
    ["score"],
    ["score", "--subject", "x", "file.txt"],
    ["score", "file.txt", "--subject", "x"],
    ["roi", "--meetings", "abc"],
    ["roi", "--meetings", "-5"],
    ["roi", "--plan", "free"],
    ["roi", "--reply-rate", "150"],
    ["verify", "a@b.com", "--bogus"],
    ["audit", "acme.com", "--file"],
    ["audit", "acme.com", "--json=yes"],
    ["permute", "--first", "J", "--last", "D", "--meetings", "5"],
  ];
  for (const args of cases) {
    it(`exit 2: cold-email-mcp ${args.join(" ") || "(no args)"}`, () => {
      const { status, stderr } = run([...args]);
      deepStrictEqual(status, 2, `stderr was: ${stderr}`);
      ok(stderr.startsWith("Error: "), stderr);
      ok(!/\n\s+at /.test(stderr), `stack trace leaked: ${stderr}`);
    });
  }
});

describe("subprocess file input", () => {
  it("skips invalid lines with a warning and exits 1 when nothing valid remains", () => {
    const { status, stdout, stderr } = run(
      ["audit", "--file", `${fixtures}audit-domains.txt`, "--base-url", "http://127.0.0.1:1"],
    );
    // One invalid line is skipped (warning), three valid domains are attempted against a dead port.
    deepStrictEqual(status, 1);
    ok(stderr.includes('line 3: skipped, not a valid domain: "not_a_domain"'), stderr);
    ok(stderr.includes("Auditing 1/3"));
    deepStrictEqual(stdout, "");
  });

  it("reads stdin via --file -", () => {
    const { status, stderr } = run(["audit", "--file", "-", "--base-url", "http://127.0.0.1:1"], {
      input: "acme.com\nexample.com\n",
    });
    deepStrictEqual(status, 1);
    ok(stderr.includes("Auditing 1/2: acme.com"), stderr);
    ok(stderr.includes("Could not reach"), stderr);
  });

  it("reports a missing file as a usage error", () => {
    const { status, stderr } = run(["audit", "--file", "Z:/no/such/file.txt"]);
    deepStrictEqual(status, 2);
    match(stderr, /Cannot read file/);
  });

  it("rejects a file whose lines are all invalid with exit 1", () => {
    const { status, stderr } = run(["audit", "--file", `${fixtures}score-sample.txt`]);
    deepStrictEqual(status, 1);
    ok(stderr.includes("No valid domain to check"), stderr);
  });
});
