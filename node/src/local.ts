import { alignRows, int, jsRound, toFixed, usd, usdCents } from "./base.js";

// ---------------------------------------------------------------------------
// Email permutations: same patterns and name cleanup as the web tool.
// ---------------------------------------------------------------------------

/** Cyrillic → Latin: email local parts are ASCII, other scripts would normalize to nothing. */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi",
  є: "ye", ґ: "g",
};

/** Lowercase, transliterate, then keep only latin letters, spaces and dashes. */
export function normalizeName(value: string): string {
  const lower = value.trim().toLowerCase();
  const transliterated = [...lower].map((ch) => CYRILLIC[ch] ?? ch).join("");
  return transliterated.replace(/[^a-z -]/g, "");
}

export function cleanDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "");
}

type Pattern = readonly [label: string, build: (first: string, last: string) => string];

const PATTERNS: readonly Pattern[] = [
  ["first@domain", (first) => first],
  ["last@domain", (_first, last) => last],
  ["first.last@domain", (first, last) => `${first}.${last}`],
  ["firstlast@domain", (first, last) => `${first}${last}`],
  ["first_last@domain", (first, last) => `${first}_${last}`],
  ["first-last@domain", (first, last) => `${first}-${last}`],
  ["f.last@domain", (first, last) => `${first.slice(0, 1)}.${last}`],
  ["fi.last@domain", (first, last) => `${first.slice(0, 2)}.${last}`],
  ["firstl@domain", (first, last) => `${first}${last.slice(0, 1)}`],
  ["first.l@domain", (first, last) => `${first}.${last.slice(0, 1)}`],
  ["last.first@domain", (first, last) => `${last}.${first}`],
  ["lfirst@domain", (first, last) => `${last.slice(0, 1)}${first}`],
];

export interface Permutation {
  readonly pattern: string;
  readonly value: string;
  readonly most_common: boolean;
}

/** Generate the patterns; duplicates are dropped, the first label wins. */
export function permute(firstName: string, lastName: string, domain: string): Permutation[] {
  const first = normalizeName(firstName);
  const last = normalizeName(lastName);
  const host = cleanDomain(domain);
  const seen = new Set<string>();
  const result: Permutation[] = [];
  for (const [label, build] of PATTERNS) {
    const local = build(first, last);
    if (local.length === 0 || seen.has(local)) continue;
    seen.add(local);
    const pattern = label.replace("@domain", host ? `@${host}` : " (local part)");
    result.push({
      pattern,
      value: host ? `${local}@${host}` : local,
      most_common: pattern.startsWith("first.last@") || pattern.startsWith("first.last ("),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Outbound cost calculator: same formula, defaults and formats as the web tool.
// ---------------------------------------------------------------------------

export const ROI_FLAGS = [
  "meetings",
  "deal-value",
  "sequence-length",
  "reply-rate",
  "reply-to-meeting",
  "close-rate",
  "sdr-meetings",
  "sdr-cost",
  "agency-per-meeting",
  "plan",
  "domain-cost",
  "inbox-cost",
  "daily-limit",
  "inboxes-per-domain",
  "sending-days",
] as const;

/** Monthly plan prices, the same list as the web calculator. */
export const PLANS = [
  { id: "starter", name: "Starter", price: 59 },
  { id: "growth", name: "Growth", price: 139 },
  { id: "scale", name: "Scale", price: 274 },
  { id: "agency", name: "Agency", price: 549 },
] as const;
export type Plan = (typeof PLANS)[number];
export const DEFAULT_PLAN: Plan = PLANS[1] as Plan;

/** Warmup rotation buffer: a domain never runs past 1/1.5 of its safe limit. */
const WARMUP_BUFFER = 1.5;

export type RoiNumberField = Exclude<keyof RoiInputs, "plan">;

export interface RoiInputSpec {
  readonly flag: string;
  readonly field: RoiNumberField;
  readonly label: string;
  /** Range of the web calculator's slider; values outside it get a warning. */
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly integer: boolean;
  readonly unit: string;
  /** True when the value is divided by, so zero is rejected. */
  readonly positive: boolean;
}

export const ROI_INPUTS: readonly RoiInputSpec[] = [
  { flag: "meetings", field: "meetings", label: "Meetings per month you need", min: 1, max: 100, fallback: 10, integer: true, unit: "", positive: true },
  { flag: "deal-value", field: "dealValue", label: "Average deal value", min: 500, max: 250_000, fallback: 5_000, integer: false, unit: " USD", positive: false },
  { flag: "sequence-length", field: "sequenceLength", label: "Emails per lead in sequence", min: 1, max: 8, fallback: 4, integer: true, unit: "", positive: true },
  { flag: "reply-rate", field: "replyRatePct", label: "Cold email reply rate", min: 0.5, max: 8, fallback: 1.5, integer: false, unit: "%", positive: false },
  { flag: "reply-to-meeting", field: "replyToMeetingPct", label: "Replies that become meetings", min: 5, max: 60, fallback: 25, integer: false, unit: "%", positive: false },
  { flag: "close-rate", field: "closeRatePct", label: "Meetings that close", min: 5, max: 60, fallback: 20, integer: false, unit: "%", positive: false },
  { flag: "sdr-meetings", field: "sdrMeetings", label: "Meetings one SDR books per month", min: 2, max: 30, fallback: 8, integer: true, unit: "", positive: true },
  { flag: "sdr-cost", field: "sdrCostYear", label: "Loaded SDR cost per year", min: 30_000, max: 150_000, fallback: 65_000, integer: false, unit: " USD", positive: false },
  { flag: "agency-per-meeting", field: "agencyPerMeeting", label: "Agency price per meeting", min: 50, max: 1_000, fallback: 250, integer: false, unit: " USD", positive: false },
  { flag: "domain-cost", field: "domainCost", label: "Extra domain cost (one-time)", min: 5, max: 30, fallback: 13, integer: false, unit: " USD", positive: false },
  { flag: "inbox-cost", field: "inboxCost", label: "Inbox cost per month", min: 1, max: 10, fallback: 3.5, integer: false, unit: " USD", positive: false },
  { flag: "daily-limit", field: "dailyLimit", label: "Safe daily limit per inbox", min: 20, max: 50, fallback: 40, integer: true, unit: "/day", positive: true },
  { flag: "inboxes-per-domain", field: "inboxesPerDomain", label: "Inboxes per domain", min: 1, max: 4, fallback: 2, integer: true, unit: "", positive: true },
  { flag: "sending-days", field: "sendingDays", label: "Sending days per week", min: 4, max: 6, fallback: 5, integer: true, unit: "", positive: true },
];

export interface RoiInputs {
  meetings: number;
  dealValue: number;
  sequenceLength: number;
  replyRatePct: number;
  replyToMeetingPct: number;
  closeRatePct: number;
  sdrMeetings: number;
  sdrCostYear: number;
  agencyPerMeeting: number;
  plan: Plan;
  domainCost: number;
  inboxCost: number;
  dailyLimit: number;
  inboxesPerDomain: number;
  sendingDays: number;
}

export function defaultRoiInputs(): RoiInputs {
  const value = (flag: string): number => ROI_INPUTS.find((spec) => spec.flag === flag)?.fallback ?? 0;
  return {
    meetings: value("meetings"),
    dealValue: value("deal-value"),
    sequenceLength: value("sequence-length"),
    replyRatePct: value("reply-rate"),
    replyToMeetingPct: value("reply-to-meeting"),
    closeRatePct: value("close-rate"),
    sdrMeetings: value("sdr-meetings"),
    sdrCostYear: value("sdr-cost"),
    agencyPerMeeting: value("agency-per-meeting"),
    plan: DEFAULT_PLAN,
    domainCost: value("domain-cost"),
    inboxCost: value("inbox-cost"),
    dailyLimit: value("daily-limit"),
    inboxesPerDomain: value("inboxes-per-domain"),
    sendingDays: value("sending-days"),
  };
}

export interface RoiModel {
  emailsMonth: number;
  leadsMonth: number;
  emailsDay: number;
  domains: number;
  inboxes: number;
  dailyCapacity: number;
  replies: number;
  closedDeals: number;
  revenueMonthly: number;
  sdrsNeeded: number;
  infraMonthly: number;
  sdrMonthly: number;
  agencyMonthly: number;
  reachfoldMonthly: number;
}

export function computeRoi(input: RoiInputs): RoiModel {
  const replyToMeeting = input.replyToMeetingPct / 100;
  const replyRate = input.replyRatePct / 100;
  const closeRate = input.closeRatePct / 100;

  // Total send volume, every sequence step included. A zero rate means the
  // target is unreachable: the volume is zero, the infrastructure stays minimal.
  const emailsMonth =
    replyRate > 0 && replyToMeeting > 0 ? input.meetings / (replyRate * replyToMeeting) : 0;
  const leadsMonth = input.sequenceLength > 0 ? emailsMonth / input.sequenceLength : 0;
  const emailsDay = emailsMonth / (input.sendingDays * 4.33);

  // Infrastructure at safe-sending limits, with the warmup rotation buffer.
  const domains = Math.max(1, Math.ceil((emailsDay / input.dailyLimit) * WARMUP_BUFFER));
  const inboxes = domains * input.inboxesPerDomain;
  const dailyCapacity = inboxes * input.dailyLimit;

  // Funnel
  const replies = emailsMonth * replyRate;
  const closedDeals = input.meetings * closeRate;
  const revenueMonthly = closedDeals * input.dealValue;

  // Routes (monthly)
  const sdrsNeeded = input.sdrMeetings > 0 ? Math.ceil(input.meetings / input.sdrMeetings) : 0;
  const infraMonthly = domains * (input.domainCost / 12) + inboxes * input.inboxCost;

  return {
    emailsMonth,
    leadsMonth,
    emailsDay,
    domains,
    inboxes,
    dailyCapacity,
    replies,
    closedDeals,
    revenueMonthly,
    sdrsNeeded,
    infraMonthly,
    sdrMonthly: (sdrsNeeded * input.sdrCostYear) / 12,
    agencyMonthly: input.meetings * input.agencyPerMeeting,
    reachfoldMonthly: input.plan.price + infraMonthly,
  };
}

export interface RoiRoute {
  readonly name: string;
  readonly monthly: number;
  readonly perMeeting: number;
  readonly cac: number;
}

export function roiRoutes(model: RoiModel, meetings: number, closedDeals: number): RoiRoute[] {
  const route = (name: string, monthly: number): RoiRoute => ({
    name,
    monthly,
    perMeeting: meetings > 0 ? monthly / meetings : 0,
    cac: closedDeals > 0 ? monthly / closedDeals : 0,
  });
  return [
    route("In-house SDR", model.sdrMonthly),
    route("Lead agency", model.agencyMonthly),
    route("Reachfold", model.reachfoldMonthly),
  ];
}

export function renderRoi(input: RoiInputs, model: RoiModel): string {
  const routes = roiRoutes(model, input.meetings, model.closedDeals);
  const emails = int(jsRound(model.emailsMonth));
  const lines = [
    `What ${input.meetings} meetings/month requires`,
    `  Emails sent / month        ${emails}`,
    `  Leads in sequence / month  ${int(jsRound(model.leadsMonth))} leads, ${input.sequenceLength} emails each`,
    `  Emails per sending day     ${int(jsRound(model.emailsDay))}`,
    `  Domains                    ${model.domains}  (${usd(input.domainCost)} one-time each, about ${usd(model.domains * input.domainCost)} setup)`,
    `  Inboxes                    ${model.inboxes}  (${usdCents(input.inboxCost)}/mo each)`,
    `  Daily send capacity        ${int(model.dailyCapacity)}/day`,
    "",
    "Funnel",
    `  Emails sent    ${emails}/mo`,
    `  Replies        ${int(jsRound(model.replies))}/mo  (${input.replyRatePct}%)`,
    `  Meetings       ${int(jsRound(input.meetings))}/mo  (${input.replyToMeetingPct}%)`,
    `  Closed deals   ${model.closedDeals >= 1 ? `${toFixed(model.closedDeals, 1)}/mo` : "< 1/mo"}  (${input.closeRatePct}%)`,
    `  Revenue/mo     ${usd(model.revenueMonthly)}`,
    `  Booked-deal value per year  ${usd(input.meetings * 12 * input.dealValue)}`,
    "",
    `What it costs (the same ${int(jsRound(input.meetings))} meetings/month, priced three ways)`,
    ...alignRows(
      routes.map((route) => [
        route.name,
        `${usd(route.monthly)}/mo`,
        `${usdCents(route.perMeeting)}/meeting`,
        `CAC ${usd(jsRound(route.cac))}`,
      ]),
    ).map((line) => `  ${line}`),
    "",
    `Reachfold route: ${input.plan.name} plan ${usd(input.plan.price)} + ${usd(model.infraMonthly)} infra, plus send credits beyond the plan allotment.`,
    "Estimates only, not a quote. Every number comes from your inputs.",
  ];
  return lines.join("\n") + "\n";
}

export function roiToJson(input: RoiInputs, model: RoiModel): string {
  const routes = roiRoutes(model, input.meetings, model.closedDeals);
  return `${JSON.stringify(
    {
      inputs: {
        meetings_per_month: input.meetings,
        deal_value: input.dealValue,
        sequence_length: input.sequenceLength,
        reply_rate_pct: input.replyRatePct,
        reply_to_meeting_pct: input.replyToMeetingPct,
        close_rate_pct: input.closeRatePct,
        sdr_meetings_per_month: input.sdrMeetings,
        sdr_cost_per_year: input.sdrCostYear,
        agency_price_per_meeting: input.agencyPerMeeting,
        plan: input.plan.id,
        plan_price_per_month: input.plan.price,
        domain_cost: input.domainCost,
        inbox_cost: input.inboxCost,
        daily_limit_per_inbox: input.dailyLimit,
        inboxes_per_domain: input.inboxesPerDomain,
        sending_days_per_week: input.sendingDays,
        warmup_buffer: WARMUP_BUFFER,
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
      routes: routes.map((route) => ({
        name: route.name,
        monthly: route.monthly,
        per_meeting: route.perMeeting,
        cac: route.cac,
      })),
      booked_deal_value_per_year: input.meetings * 12 * input.dealValue,
    },
    null,
    2,
  )}\n`;
}

/** Help text of one ROI option, shared by parsing and `roi --help`. */
export function roiOptionHelp(): Record<string, string> {
  const help: Record<string, string> = { plan: "Reachfold plan: starter, growth, scale or agency (default growth)" };
  for (const spec of ROI_INPUTS) {
    const fallback = String(spec.fallback);
    const extra = spec.flag === "meetings" ? "/month" : "";
    help[spec.flag] = `${spec.label}${extra} (default ${fallback}${spec.unit}; calculator range ${spec.min} to ${spec.max})`;
  }
  return help;
}
