import { deepStrictEqual, ok, rejects } from "node:assert";
import { after, describe, it } from "node:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runCli } from "../src/cli.js";
import type { HttpSettings } from "../src/http.js";
import { CliError, systemIo } from "../src/base.js";

/** Deterministic clock: sleep only advances it, so throttle and backoff are testable. */
class FakeClock {
  private time = 0;
  readonly now = (): number => this.time;
  readonly sleep = (ms: number): Promise<void> => {
    this.time += ms;
    return Promise.resolve();
  };
  get value(): number {
    return this.time;
  }
}

interface ScriptStep {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface Recorded {
  path: string;
  body: string;
}

function startScriptedServer(script: ScriptStep[]): Promise<{
  url: string;
  requests: Recorded[];
  served: () => number;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: raw });
      const step = script.shift() ?? { status: 500, body: '{"error":"out_of_script"}' };
      response.writeHead(step.status, { "content-type": "application/json", ...step.headers });
      response.end(step.body);
    });
  });
  const requests: Recorded[] = [];
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        served: () => requests.length,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function testSettings(clock: FakeClock, overrides: Partial<HttpSettings> = {}): HttpSettings {
  return {
    timeoutMs: 5_000,
    minIntervalMs: 500,
    retryDelaysMs: [1_000, 2_000],
    maxRetryAfterMs: 30_000,
    sleep: clock.sleep,
    now: clock.now,
    fetchImpl: fetch,
    ...overrides,
  };
}

const io = systemIo();

/** Same error handling as main(), so tests see the exit code a user would get. */
async function capture(args: readonly string[], settings: HttpSettings): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const sink = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    env: {},
    readTextFile: (path: string) => readFileSync(path, "utf8"),
  };
  let code: number;
  try {
    code = await runCli(args, sink, settings);
  } catch (err) {
    if (err instanceof CliError) {
      stderr += `Error: ${err.message}\n`;
      code = err.exitCode;
    } else {
      stderr += `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`;
      code = 1;
    }
  }
  return { code, stdout, stderr };
}

import { readFileSync } from "node:fs";

describe("http client against a local mock", () => {
  const cleanups: (() => Promise<void>)[] = [];
  const startServer = async (script: ScriptStep[]) => {
    const server = await startScriptedServer(script);
    cleanups.push(server.close);
    return server;
  };

  after(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  it("posts one JSON request per item and prints rows", async () => {
    const server = await startServer([
      { status: 200, body: '{"email":"a@b.com","status":"valid","reason":"ok","flags":[],"mx":["mx1"]}' },
      { status: 200, body: '{"email":"c@d.com","status":"risky","reason":"no_mx","flags":["role"]}' },
    ]);
    const clock = new FakeClock();
    const { code, stdout } = await capture(
      ["verify", "a@b.com", "c@d.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 0);
    ok(stdout.includes("a@b.com") && stdout.includes("valid"));
    ok(stdout.includes("c@d.com") && stdout.includes("risky"));
    deepStrictEqual(server.served(), 2);
    deepStrictEqual(JSON.parse(server.requests[0]!.body), { email: "a@b.com" });
  });

  it("retries 429 with exponential backoff and then succeeds", async () => {
    const server = await startServer([
      { status: 429, body: '{"error":"rate_limited","message":"Too many requests."}' },
      { status: 200, body: '{"email":"a@b.com","status":"valid","reason":"ok","flags":[]}' },
    ]);
    const clock = new FakeClock();
    const { code, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 0);
    ok(stderr.includes("HTTP 429") && stderr.includes("retrying in 1s"));
    deepStrictEqual(server.served(), 2);
    ok(clock.value >= 1_000, "backoff delay respected");
  });

  it("gives up after 3 attempts on persistent 429 and exits 1", async () => {
    const step = { status: 429, body: '{"error":"rate_limited","message":"Too many requests."}' };
    const server = await startServer([step, step, step]);
    const clock = new FakeClock();
    const { code, stdout, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 1);
    ok(stderr.includes("Too many requests — wait a few seconds and retry"));
    deepStrictEqual(stdout, "");
    deepStrictEqual(server.served(), 3);
  });

  it("honours Retry-After but refuses to wait longer than the ceiling", async () => {
    const server = await startServer([
      { status: 429, body: "{}", headers: { "retry-after": "45" } },
    ]);
    const clock = new FakeClock();
    const { code, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 1);
    deepStrictEqual(server.served(), 1, "45 s Retry-After exceeds the ceiling: no retry");
    ok(!stderr.includes("retrying"));
  });

  it("retries 5xx once and then succeeds", async () => {
    const server = await startServer([
      { status: 502, body: "bad gateway" },
      { status: 200, body: '{"email":"a@b.com","status":"valid","reason":"ok","flags":[]}' },
    ]);
    const clock = new FakeClock();
    const { code } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 0);
    deepStrictEqual(server.served(), 2);
  });

  it("continues the batch after a per-item 422 and exits 1", async () => {
    const server = await startServer([
      { status: 422, body: '{"error":"invalid_email","message":"Provide a valid email address."}' },
      { status: 200, body: '{"email":"ok@fine.com","status":"valid","reason":"ok","flags":[]}' },
    ]);
    const clock = new FakeClock();
    const { code, stdout, stderr } = await capture(
      ["verify", "x@y.zz", "ok@fine.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 1);
    ok(stderr.includes("FAILED x@y.zz") && stderr.includes("invalid_email"));
    ok(stdout.includes("ok@fine.com"), "the good row is still printed");
    deepStrictEqual(server.served(), 2);
  });

  it("fails with a clear message on a non-JSON 200", async () => {
    const server = await startServer([{ status: 200, body: "<html>oops</html>" }]);
    const clock = new FakeClock();
    const { code, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 1);
    ok(stderr.includes("not valid JSON"));
  });

  it("throttles batch runs to at most one request every 500 ms", async () => {
    const ok200 = { status: 200, body: '{"email":"a@b.com","status":"valid","reason":"ok","flags":[]}' };
    const server = await startServer([ok200, ok200, ok200, ok200]);
    const clock = new FakeClock();
    const { code } = await capture(
      ["verify", "a@b.com", "a@b.com", "a@b.com", "a@b.com", "--no-banner", "--base-url", server.url],
      testSettings(clock),
    );
    deepStrictEqual(code, 0);
    deepStrictEqual(server.served(), 4);
    ok(clock.value >= 1_500, `expected at least 3 x 500 ms of throttle gaps, got ${clock.value}`);
  });

  it("translates network failures into one-line errors", async () => {
    const clock = new FakeClock();
    const failing: HttpSettings = {
      ...testSettings(clock),
      fetchImpl: (() => Promise.reject(new Error("dns down"))) as unknown as typeof fetch,
    };
    const { code, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", "https://no-such-host.invalid"],
      failing,
    );
    deepStrictEqual(code, 1);
    ok(stderr.includes("Could not reach") || stderr.includes("Could not resolve"));
    ok(!stderr.includes("at "), "no stack trace");
  });

  it("reports timeouts without a stack trace", async () => {
    const clock = new FakeClock();
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const failing: HttpSettings = {
      ...testSettings(clock),
      fetchImpl: (() => Promise.reject(timeout)) as unknown as typeof fetch,
    };
    const { code, stderr } = await capture(
      ["verify", "a@b.com", "--no-banner", "--base-url", "https://slow.example"],
      failing,
    );
    deepStrictEqual(code, 1);
    ok(stderr.includes("timed out"));
  });

  it("uses the default settings object unchanged", async () => {
    const { DEFAULT_HTTP_SETTINGS } = await import("../src/http.js");
    deepStrictEqual(DEFAULT_HTTP_SETTINGS.retryDelaysMs, [1_000, 2_000]);
    deepStrictEqual(DEFAULT_HTTP_SETTINGS.minIntervalMs, 500);
    await rejects(
      async () => {
        await runCli(["verify"], io, { ...DEFAULT_HTTP_SETTINGS, fetchImpl: fetch });
      },
      /Provide at least one email/,
    );
  });
});
