import { readFileSync } from "node:fs";
import { deepStrictEqual, ok, throws } from "node:assert";
import { before, describe, it } from "node:test";
import { cleanDomain, computeRoi, defaultRoiInputs, normalizeName, permute, PLANS, type RoiInputs } from "../src/local.js";
import { int, jsRound, toFixed, usd, usdCents } from "../src/base.js";
import { bodyFromFile, isDomain, isEmail, normalizeDomain, normalizeEmail, parseNumber, splitEmailFile } from "../src/inputs.js";
import { UsageError } from "../src/base.js";

const fixtureUrl = new URL("../../../fixtures/permutations.json", import.meta.url);
const roiFixtureUrl = new URL("../../../fixtures/roi.json", import.meta.url);

interface PermutationCase {
  name: string;
  first: string;
  last: string;
  domain: string;
  expected: string[];
}

interface RoiCase {
  name: string;
  inputs: Record<string, string>;
  expected: Record<string, unknown>;
}

let permutationCases: PermutationCase[] = [];
let roiCases: RoiCase[] = [];

before(() => {
  permutationCases = (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { cases: PermutationCase[] }).cases;
  roiCases = (JSON.parse(readFileSync(roiFixtureUrl, "utf8")) as { cases: RoiCase[] }).cases;
});

describe("permute", () => {
  it("matches the web tool fixture", () => {
    for (const testCase of permutationCases) {
      const result = permute(testCase.first, testCase.last, testCase.domain);
      deepStrictEqual(
        result.map((item) => item.value),
        testCase.expected,
        testCase.name,
      );
      const withDomain = testCase.domain.length > 0;
      if (withDomain) {
        ok(result.every((item) => item.value.endsWith(`@${cleanDomain(testCase.domain)}`)), testCase.name);
        deepStrictEqual(result.filter((item) => item.most_common).length, 1, testCase.name);
      }
    }
  });

  it("keeps the web tool's pattern order and cleanup", () => {
    deepStrictEqual(normalizeName("  ИВАН "), "ivan");
    deepStrictEqual(normalizeName("O'Brien!"), "obrien");
    deepStrictEqual(cleanDomain("HTTPS://Sub.Acme.COM/path/"), "sub.acme.com");
    deepStrictEqual(cleanDomain("@acme.com"), "acme.com");
  });
});

describe("roi", () => {
  it("matches the generated fixture in every case", () => {
    for (const testCase of roiCases) {
      const fieldByFlag: Record<string, keyof RoiInputs> = {
        meetings: "meetings",
        "deal-value": "dealValue",
        "sequence-length": "sequenceLength",
        "reply-rate": "replyRatePct",
        "reply-to-meeting": "replyToMeetingPct",
        "close-rate": "closeRatePct",
        "sdr-meetings": "sdrMeetings",
        "sdr-cost": "sdrCostYear",
        "agency-per-meeting": "agencyPerMeeting",
        "domain-cost": "domainCost",
        "inbox-cost": "inboxCost",
        "daily-limit": "dailyLimit",
        "inboxes-per-domain": "inboxesPerDomain",
        "sending-days": "sendingDays",
      };
      const inputs = defaultRoiInputs();
      for (const [flag, raw] of Object.entries(testCase.inputs)) {
        if (flag === "plan") {
          inputs.plan = PLANS.find((candidate) => candidate.id === raw) ?? PLANS[1]!;
          continue;
        }
        const key = fieldByFlag[flag];
        ok(key !== undefined, `unknown fixture flag ${flag}`);
        (inputs as unknown as Record<string, unknown>)[key] = Number(raw);
      }
      const model = computeRoi(inputs);
      const plan = inputs.plan;
      const actual = {
        inputs: {
          meetings_per_month: inputs.meetings,
          deal_value: inputs.dealValue,
          sequence_length: inputs.sequenceLength,
          reply_rate_pct: inputs.replyRatePct,
          reply_to_meeting_pct: inputs.replyToMeetingPct,
          close_rate_pct: inputs.closeRatePct,
          sdr_meetings_per_month: inputs.sdrMeetings,
          sdr_cost_per_year: inputs.sdrCostYear,
          agency_price_per_meeting: inputs.agencyPerMeeting,
          plan: inputs.plan.id,
          plan_price_per_month: plan.price,
          domain_cost: inputs.domainCost,
          inbox_cost: inputs.inboxCost,
          daily_limit_per_inbox: inputs.dailyLimit,
          inboxes_per_domain: inputs.inboxesPerDomain,
          sending_days_per_week: inputs.sendingDays,
          warmup_buffer: 1.5,
        },
        emails_per_month: model.emailsMonth,
        leads_per_month: model.leadsMonth,
        emails_per_sending_day: model.emailsDay,
        domains: model.domains,
        inboxes: model.inboxes,
        daily_capacity: model.dailyCapacity,
        replies_per_month: model.replies,
        closed_deals_per_month: model.closedDeals,
        revenue_per_month: model.revenueMonthly,
        sdrs_needed: model.sdrsNeeded,
        infra_per_month: model.infraMonthly,
        routes: [
          { name: "In-house SDR", monthly: model.sdrMonthly, per_meeting: model.sdrMonthly / inputs.meetings, cac: model.sdrMonthly / model.closedDeals },
          { name: "Lead agency", monthly: model.agencyMonthly, per_meeting: model.agencyMonthly / inputs.meetings, cac: model.agencyMonthly / model.closedDeals },
          { name: "Reachfold", monthly: model.reachfoldMonthly, per_meeting: model.reachfoldMonthly / inputs.meetings, cac: model.reachfoldMonthly / model.closedDeals },
        ],
        booked_deal_value_per_year: inputs.meetings * 12 * inputs.dealValue,
      };
      deepStrictEqual(actual, testCase.expected, testCase.name);
    }
  });

  it("renders numbers like the web calculator", () => {
    const model = computeRoi(defaultRoiInputs());
    deepStrictEqual(int(jsRound(model.emailsMonth)), "2,667");
    deepStrictEqual(usd(model.sdrMonthly), "$10,833");
    deepStrictEqual(usdCents(model.infraMonthly / model.inboxes), "$4.04");
    deepStrictEqual(toFixed(model.closedDeals, 1), "2.0");
  });

  it("handles a zero rate exactly like the web tool (site fixture)", () => {
    const inputs = { ...defaultRoiInputs(), replyRatePct: 0, closeRatePct: 0 };
    const model = computeRoi(inputs);
    deepStrictEqual(model.emailsMonth, 0);
    deepStrictEqual(model.domains, 1);
    deepStrictEqual(model.inboxes, 2);
    deepStrictEqual(model.dailyCapacity, 80);
    deepStrictEqual(model.closedDeals, 0);
    const withReplyToMeetingZero = computeRoi({ ...defaultRoiInputs(), replyToMeetingPct: 0 });
    deepStrictEqual(withReplyToMeetingZero.emailsMonth, 0);
    deepStrictEqual(withReplyToMeetingZero.closedDeals, 2);
  });

  it("uses the web calculator's plan prices", () => {
    deepStrictEqual(PLANS.map((plan) => plan.price), [59, 139, 274, 549]);
  });
});

describe("inputs", () => {
  it("validates like the API does", () => {
    ok(isEmail("test@gmail.com"));
    ok(!isEmail("not-an-email"));
    ok(!isEmail("a@b"));
    deepStrictEqual(normalizeEmail("  Test@GMAIL.Com "), "test@gmail.com");
    ok(isDomain(normalizeDomain("https://Sub.Acme.com/path")));
    ok(!isDomain("bad_domain"));
    ok(!isDomain("localhost"));
  });

  it("rejects non-numbers with a usage error", () => {
    deepStrictEqual(parseNumber("meetings", "25"), 25);
    throws(() => parseNumber("meetings", "abc"), UsageError);
    throws(() => parseNumber("meetings", "0x10"), UsageError);
  });

  it("splits subject and body on the first blank line", () => {
    deepStrictEqual(splitEmailFile("Subject line\n\nBody here"), { subject: "Subject line", body: "Body here" });
    deepStrictEqual(splitEmailFile("No blank line"), { subject: "", body: "No blank line" });
    deepStrictEqual(splitEmailFile("Subject\n\n\nBody"), { subject: "Subject", body: "\nBody" });
    deepStrictEqual(bodyFromFile("Body\n"), "Body");
  });
});
