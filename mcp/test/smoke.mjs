// Smoke test: spawns the built stdio server, completes the MCP handshake and
// checks that exactly the five tools are listed. No network calls.
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const server = spawn(process.execPath, ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
});

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const line = buffer.split("\n").find(predicate);
      if (line) return resolve(line);
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for server reply"));
      setTimeout(poll, 50);
    };
    poll();
  });
}

test.after(() => {
  server.kill();
});

test("initialize, tools/list and a local tool call work over stdio", async () => {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const initLine = await waitFor((line) => line.includes('"id":1'));
  const init = JSON.parse(initLine);
  assert.equal(init.result.serverInfo.name, "cold-email-mcp");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listLine = await waitFor((line) => line.includes('"id":2'));
  const tools = JSON.parse(listLine).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, [
    "audit_domain",
    "calculate_outbound_roi",
    "generate_email_permutations",
    "score_email",
    "verify_email",
  ]);

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate_email_permutations", arguments: { first_name: "Jane", last_name: "Doe" } } });
  const callLine = await waitFor((line) => line.includes('"id":3'));
  const call = JSON.parse(callLine);
  assert.equal(call.result.isError, undefined);
  assert.ok(JSON.stringify(call.result.structuredContent.permutations).includes("jane.doe"));
});
