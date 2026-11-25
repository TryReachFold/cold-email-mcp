// cold-email-mcp-server — local stdio MCP server for the five free cold-email
// checks by Reachfold (the hosted twin lives at https://tryreachfold.com/api/mcp).
// Built with the MCP TypeScript SDK v2: a fresh McpServer per connection,
// zod input schemas, structuredContent + a text fallback, honest descriptions.
// Network tools call the public tryreachfold.com REST API; permutations and
// ROI run fully offline (same code paths as the CLI in node/).

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import {
  defaultRoiInputs,
  permute,
  PLANS,
  computeRoi,
  roiToJson,
  type Plan,
} from "./local.js";

const BASE_URL = (
  process.env.COLD_EMAIL_MCP_BASE_URL || "https://tryreachfold.com"
).replace(/\/+$/, "");

const SIGNATURE =
  "Source: Reachfold cold-email-mcp — https://tryreachfold.com/tools?utm_source=mcp&utm_medium=referral&utm_campaign=waitlist-launch";

const DNS_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const PURE_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    throw new Error("Rate limited (30 requests per 10 seconds per IP). Wait a few seconds and retry.");
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data.message === "string" && data.message) message = data.message;
    } catch {
      // non-JSON error body — keep the HTTP status line
    }
    throw new Error(message);
  }
  return res.json();
}

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: `${JSON.stringify(payload, null, 2)}\n\n${SIGNATURE}` }],
    structuredContent: payload,
  };
}

const domainSchema = z.object({
  domain: z.string().describe('Sending domain to check, e.g. "acme.com"'),
});
const emailSchema = z.object({
  email: z.string().describe('Email address to check, e.g. "jane@acme.com"'),
});
const scoreSchema = z.object({
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Plain-text email body"),
});
const permuteSchema = z.object({
  first_name: z.string().describe("First name (any script; Cyrillic is transliterated)"),
  last_name: z.string().describe("Last name (any script; Cyrillic is transliterated)"),
  domain: z.string().optional().describe('Corporate domain, e.g. "acme.com"'),
});

const planSchema = z.enum(PLANS.map((plan) => plan.id) as [string, ...string[]]);
// ROI inputs default to the web calculator's values; every field is optional.
const roiNumber = (field: string, fallback: number) =>
  z.number().optional().describe(`${field} (default ${fallback})`);
const roiSchema = z.object({
  meetings: roiNumber("Meetings per month you need", 10),
  deal_value: roiNumber("Average deal value, USD", 5000),
  sequence_length: roiNumber("Emails per lead in the sequence", 4),
  reply_rate: roiNumber("Cold email reply rate, %", 1.5),
  reply_to_meeting: roiNumber("Replies that become meetings, %", 25),
  close_rate: roiNumber("Meetings that close, %", 20),
  sdr_meetings: roiNumber("Meetings one SDR books per month", 8),
  sdr_cost: roiNumber("Loaded SDR cost per year, USD", 65000),
  agency_per_meeting: roiNumber("Agency price per meeting, USD", 250),
  plan: planSchema.optional().describe("Reachfold plan used in the comparison (default growth)"),
  domain_cost: roiNumber("Extra sending domain cost, USD one-time", 13),
  inbox_cost: roiNumber("Inbox cost per month, USD", 3.5),
  daily_limit: roiNumber("Safe daily limit per inbox", 40),
  inboxes_per_domain: roiNumber("Inboxes per domain", 2),
  sending_days: roiNumber("Sending days per week", 5),
});

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "cold-email-mcp", version: "0.1.0" },
    {
      instructions:
        "Reachfold cold-email-mcp: five read-only cold-email utilities — a DNS deliverability audit, a spam-word score, a DNS-level email check, corporate email-permutation guessing and outbound ROI arithmetic. DNS tools read live DNS and check DNS-level signals only: no IP blacklists, no inbox-placement tests, no SMTP mailbox checks. These utilities are the free layer of Reachfold — an AI SDR for cold outreach with human-approved sends; early access: https://tryreachfold.com/?utm_source=mcp&utm_medium=referral&utm_campaign=waitlist-launch",
    },
  );

  server.registerTool(
    "audit_domain",
    {
      title: "Deliverability audit",
      description: `Grade a sending domain before a campaign: SPF with its DNS-lookup count against the limit of 10, DKIM on known selectors, DMARC, MTA-STS, MX (and null MX), domain age via RDAP — scored 0-100 with fixes in plain language.

DNS-level only: no IP blacklists, no inbox-placement tests, no email headers. "DKIM not found" means the selector list was exhausted, not that DKIM is broken.`,
      inputSchema: domainSchema,
      annotations: DNS_ANNOTATIONS,
    },
    async ({ domain }) => textResult(await postJson("/api/tools/dns-audit", { domain })),
  );

  server.registerTool(
    "verify_email",
    {
      title: "Email check",
      description: `Check an email address at the DNS level: syntax, domain existence, MX, disposable and role-address flags.

No SMTP handshake: "valid" means the domain can receive mail, not that the mailbox exists; catch-all domains are not detected.`,
      inputSchema: emailSchema,
      annotations: DNS_ANNOTATIONS,
    },
    async ({ email }) => textResult(await postJson("/api/tools/verify-email", { email })),
  );

  server.registerTool(
    "score_email",
    {
      title: "Spam score",
      description: `Score an email draft (subject + plain-text body) against a deterministic spam-word and pattern heuristic: 0-100, every trigger with its points, verdict low (0-24) / medium (25-49) / high (50+).

A word-and-pattern heuristic: not SpamAssassin and not a Gmail/Outlook placement forecast. Pure arithmetic, no external calls.`,
      inputSchema: scoreSchema,
      annotations: PURE_ANNOTATIONS,
    },
    async ({ subject, body }) => textResult(await postJson("/api/tools/spam-score", { subject, body })),
  );

  server.registerTool(
    "generate_email_permutations",
    {
      title: "Email permutations",
      description: `Generate the common corporate email patterns for a first name, last name and optional domain (12 patterns: first.last, firstlast, f.last, ...), Cyrillic names transliterated.

Patterns are guesses, not verified addresses — use verify_email on the top candidates.`,
      inputSchema: permuteSchema,
      annotations: PURE_ANNOTATIONS,
    },
    async ({ first_name, last_name, domain }) => {
      const cleanDomain = domain ? domain.trim().toLowerCase() : "";
      const permutations = permute(first_name, last_name, cleanDomain);
      return textResult({ first_name, last_name, domain: cleanDomain || null, permutations });
    },
  );

  server.registerTool(
    "calculate_outbound_roi",
    {
      title: "Outbound ROI",
      description: `Compute what a meetings-per-month target requires and costs, three ways (in-house SDR, lead agency, Reachfold plan): required email volume, sending domains/inboxes at safe limits with a 1.5x warmup buffer, the reply-to-revenue funnel, and per-route monthly cost with cost-per-meeting and CAC.

Arithmetic on the given inputs — estimates, not a quote. Defaults match the Reachfold ROI calculator.`,
      inputSchema: roiSchema,
      annotations: PURE_ANNOTATIONS,
    },
    async (input) => {
      const defaults = defaultRoiInputs();
      const plan: Plan =
        (PLANS.find((candidate) => candidate.id === (input.plan ?? defaults.plan.id)) ??
          defaults.plan) as Plan;
      const roiInput = {
        ...defaults,
        plan,
        meetings: input.meetings ?? defaults.meetings,
        dealValue: input.deal_value ?? defaults.dealValue,
        sequenceLength: input.sequence_length ?? defaults.sequenceLength,
        replyRatePct: input.reply_rate ?? defaults.replyRatePct,
        replyToMeetingPct: input.reply_to_meeting ?? defaults.replyToMeetingPct,
        closeRatePct: input.close_rate ?? defaults.closeRatePct,
        sdrMeetings: input.sdr_meetings ?? defaults.sdrMeetings,
        sdrCostYear: input.sdr_cost ?? defaults.sdrCostYear,
        agencyPerMeeting: input.agency_per_meeting ?? defaults.agencyPerMeeting,
        domainCost: input.domain_cost ?? defaults.domainCost,
        inboxCost: input.inbox_cost ?? defaults.inboxCost,
        dailyLimit: input.daily_limit ?? defaults.dailyLimit,
        inboxesPerDomain: input.inboxes_per_domain ?? defaults.inboxesPerDomain,
        sendingDays: input.sending_days ?? defaults.sendingDays,
      };
      const model = computeRoi(roiInput);
      return {
        content: [{ type: "text" as const, text: `${roiToJson(roiInput, model)}\n${SIGNATURE}` }],
        structuredContent: JSON.parse(roiToJson(roiInput, model)),
      };
    },
  );

  return server;
}

// Entry point: stdio transport for Claude Desktop / local MCP clients.
// Server-side entry (HTTP) is not part of this package — the hosted server
// runs at https://tryreachfold.com/api/mcp.
const isMain = process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false;
if (isMain) {
  try {
    await serveStdio(createServer);
  } catch (error: unknown) {
    console.error("cold-email-mcp-server failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
