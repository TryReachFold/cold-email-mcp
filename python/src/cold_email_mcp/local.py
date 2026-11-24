"""Offline commands: same patterns, formula, defaults and formats as the web tools."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from typing import TypedDict

from .base import align_rows, int_text, js_round, js_str, to_fixed, usd, usd_cents

# --- Email permutations -------------------------------------------------------

# Cyrillic to Latin: email local parts are ASCII, other scripts would normalize to nothing.
CYRILLIC = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
    "і": "i",
    "ї": "yi",
    "є": "ye",
    "ґ": "g",
}

# What JavaScript's String.prototype.trim strips; str.strip() uses a different set.
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

_NON_LATIN = re.compile(r"[^a-z -]")
_SCHEME = re.compile(r"^https?://", re.IGNORECASE)
_LEADING_AT = re.compile(r"^@")
_FROM_SLASH = re.compile(r"/.*$")


def js_trim(value: str) -> str:
    return value.strip(JS_WHITESPACE)


def normalize_name(value: str) -> str:
    """Lowercase, transliterate, then keep only latin letters, spaces and dashes."""
    lower = js_trim(value).lower()
    transliterated = "".join(CYRILLIC.get(char, char) for char in lower)
    return _NON_LATIN.sub("", transliterated)


def clean_domain(domain: str) -> str:
    value = _SCHEME.sub("", js_trim(domain).lower(), count=1)
    return _FROM_SLASH.sub("", _LEADING_AT.sub("", value, count=1), count=1)


PATTERNS: tuple[tuple[str, Callable[[str, str], str]], ...] = (
    ("first@domain", lambda first, _last: first),
    ("last@domain", lambda _first, last: last),
    ("first.last@domain", lambda first, last: f"{first}.{last}"),
    ("firstlast@domain", lambda first, last: f"{first}{last}"),
    ("first_last@domain", lambda first, last: f"{first}_{last}"),
    ("first-last@domain", lambda first, last: f"{first}-{last}"),
    ("f.last@domain", lambda first, last: f"{first[:1]}.{last}"),
    ("fi.last@domain", lambda first, last: f"{first[:2]}.{last}"),
    ("firstl@domain", lambda first, last: f"{first}{last[:1]}"),
    ("first.l@domain", lambda first, last: f"{first}.{last[:1]}"),
    ("last.first@domain", lambda first, last: f"{last}.{first}"),
    ("lfirst@domain", lambda first, last: f"{last[:1]}{first}"),
)


class Permutation(TypedDict):
    pattern: str
    value: str
    most_common: bool


def permute(first_name: str, last_name: str, domain: str) -> list[Permutation]:
    """Generate the patterns; duplicates are dropped, the first label wins."""
    first = normalize_name(first_name)
    last = normalize_name(last_name)
    host = clean_domain(domain)
    suffix = f"@{host}" if host else " (local part)"
    seen: set[str] = set()
    result: list[Permutation] = []
    for label, build in PATTERNS:
        local = build(first, last)
        if not local or local in seen:
            continue
        seen.add(local)
        pattern = label.replace("@domain", suffix, 1)
        result.append(
            {
                "pattern": pattern,
                "value": f"{local}@{host}" if host else local,
                "most_common": pattern.startswith(("first.last@", "first.last (")),
            }
        )
    return result


# --- Outbound cost calculator --------------------------------------------------

ROI_FLAGS = (
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
)

# Monthly plan prices, the same list as the web calculator.
PLANS = (
    {"id": "starter", "name": "Starter", "price": 59},
    {"id": "growth", "name": "Growth", "price": 139},
    {"id": "scale", "name": "Scale", "price": 274},
    {"id": "agency", "name": "Agency", "price": 549},
)

# Warmup rotation buffer: a domain never runs past 1/1.5 of its safe limit.
WARMUP_BUFFER = 1.5


class RoiInputSpec(TypedDict):
    flag: str
    label: str
    min: float  # range of the web calculator's slider; values outside it get a warning
    max: float
    fallback: float
    integer: bool
    unit: str
    positive: bool  # True when the value is divided by, so zero is rejected


ROI_INPUTS: tuple[RoiInputSpec, ...] = (
    {
        "flag": "meetings",
        "field": "meetings",
        "label": "Meetings per month you need",
        "min": 1,
        "max": 100,
        "fallback": 10,
        "integer": True,
        "unit": "",
        "positive": True,
    },
    {
        "flag": "deal-value",
        "field": "deal_value",
        "label": "Average deal value",
        "min": 500,
        "max": 250_000,
        "fallback": 5_000,
        "integer": False,
        "unit": " USD",
        "positive": False,
    },
    {
        "flag": "sequence-length",
        "field": "sequence_length",
        "label": "Emails per lead in sequence",
        "min": 1,
        "max": 8,
        "fallback": 4,
        "integer": True,
        "unit": "",
        "positive": True,
    },
    {
        "flag": "reply-rate",
        "field": "reply_rate_pct",
        "label": "Cold email reply rate",
        "min": 0.5,
        "max": 8,
        "fallback": 1.5,
        "integer": False,
        "unit": "%",
        "positive": False,
    },
    {
        "flag": "reply-to-meeting",
        "field": "reply_to_meeting_pct",
        "label": "Replies that become meetings",
        "min": 5,
        "max": 60,
        "fallback": 25,
        "integer": False,
        "unit": "%",
        "positive": False,
    },
    {
        "flag": "close-rate",
        "field": "close_rate_pct",
        "label": "Meetings that close",
        "min": 5,
        "max": 60,
        "fallback": 20,
        "integer": False,
        "unit": "%",
        "positive": False,
    },
    {
        "flag": "sdr-meetings",
        "field": "sdr_meetings",
        "label": "Meetings one SDR books per month",
        "min": 2,
        "max": 30,
        "fallback": 8,
        "integer": True,
        "unit": "",
        "positive": True,
    },
    {
        "flag": "sdr-cost",
        "field": "sdr_cost_year",
        "label": "Loaded SDR cost per year",
        "min": 30_000,
        "max": 150_000,
        "fallback": 65_000,
        "integer": False,
        "unit": " USD",
        "positive": False,
    },
    {
        "flag": "agency-per-meeting",
        "field": "agency_per_meeting",
        "label": "Agency price per meeting",
        "min": 50,
        "max": 1_000,
        "fallback": 250,
        "integer": False,
        "unit": " USD",
        "positive": False,
    },
    {
        "flag": "domain-cost",
        "field": "domain_cost",
        "label": "Extra domain cost (one-time)",
        "min": 5,
        "max": 30,
        "fallback": 13,
        "integer": False,
        "unit": " USD",
        "positive": False,
    },
    {
        "flag": "inbox-cost",
        "field": "inbox_cost",
        "label": "Inbox cost per month",
        "min": 1,
        "max": 10,
        "fallback": 3.5,
        "integer": False,
        "unit": " USD",
        "positive": False,
    },
    {
        "flag": "daily-limit",
        "field": "daily_limit",
        "label": "Safe daily limit per inbox",
        "min": 20,
        "max": 50,
        "fallback": 40,
        "integer": True,
        "unit": "/day",
        "positive": True,
    },
    {
        "flag": "inboxes-per-domain",
        "field": "inboxes_per_domain",
        "label": "Inboxes per domain",
        "min": 1,
        "max": 4,
        "fallback": 2,
        "integer": True,
        "unit": "",
        "positive": True,
    },
    {
        "flag": "sending-days",
        "field": "sending_days",
        "label": "Sending days per week",
        "min": 4,
        "max": 6,
        "fallback": 5,
        "integer": True,
        "unit": "",
        "positive": True,
    },
)


class RoiInputs(TypedDict):
    meetings: float
    deal_value: float
    sequence_length: float
    reply_rate_pct: float
    reply_to_meeting_pct: float
    close_rate_pct: float
    sdr_meetings: float
    sdr_cost_year: float
    agency_per_meeting: float
    plan: str
    domain_cost: float
    inbox_cost: float
    daily_limit: float
    inboxes_per_domain: float
    sending_days: float


class RoiModel(TypedDict):
    emails_month: float
    leads_month: float
    emails_day: float
    domains: int
    inboxes: float
    daily_capacity: float
    replies: float
    closed_deals: float
    revenue_monthly: float
    sdrs_needed: int
    infra_monthly: float
    sdr_monthly: float
    agency_monthly: float
    reachfold_monthly: float


def default_roi_inputs() -> RoiInputs:
    return {spec["field"]: spec["fallback"] for spec in ROI_INPUTS} | {"plan": PLANS[1]["id"]}


def plan_by_id(plan_id: str) -> Mapping[str, str | int] | None:
    return next((plan for plan in PLANS if plan["id"] == plan_id), None)


def require_plan(inputs: RoiInputs) -> Mapping[str, str | int]:
    plan = plan_by_id(inputs["plan"])
    if plan is None:
        raise ValueError(f"Unknown plan: {inputs['plan']}")
    return plan


def compute_roi(inputs: RoiInputs) -> RoiModel:
    """The web calculator's formula, in the same operation order (so the same digits)."""
    reply_to_meeting = inputs["reply_to_meeting_pct"] / 100
    reply_rate = inputs["reply_rate_pct"] / 100
    close_rate = inputs["close_rate_pct"] / 100

    # Total send volume, every sequence step included. A zero rate means the
    # target is unreachable: the volume is zero, the infrastructure stays minimal.
    emails_month = (
        inputs["meetings"] / (reply_rate * reply_to_meeting)
        if reply_rate > 0 and reply_to_meeting > 0
        else 0
    )
    sequence_length = inputs["sequence_length"]
    leads_month = emails_month / sequence_length if sequence_length > 0 else 0
    emails_day = emails_month / (inputs["sending_days"] * 4.33)

    # Infrastructure at safe-sending limits, with the warmup rotation buffer.
    domains = max(1, math.ceil((emails_day / inputs["daily_limit"]) * WARMUP_BUFFER))
    inboxes = domains * inputs["inboxes_per_domain"]
    daily_capacity = inboxes * inputs["daily_limit"]

    # Funnel
    replies = emails_month * reply_rate
    closed_deals = inputs["meetings"] * close_rate
    revenue_monthly = closed_deals * inputs["deal_value"]

    # Routes (monthly)
    sdr_meetings = inputs["sdr_meetings"]
    sdrs_needed = math.ceil(inputs["meetings"] / sdr_meetings) if sdr_meetings > 0 else 0
    infra_monthly = domains * (inputs["domain_cost"] / 12) + inboxes * inputs["inbox_cost"]

    return {
        "emails_month": emails_month,
        "leads_month": leads_month,
        "emails_day": emails_day,
        "domains": domains,
        "inboxes": inboxes,
        "daily_capacity": daily_capacity,
        "replies": replies,
        "closed_deals": closed_deals,
        "revenue_monthly": revenue_monthly,
        "sdrs_needed": sdrs_needed,
        "infra_monthly": infra_monthly,
        "sdr_monthly": (sdrs_needed * inputs["sdr_cost_year"]) / 12,
        "agency_monthly": inputs["meetings"] * inputs["agency_per_meeting"],
        "reachfold_monthly": require_plan(inputs)["price"] + infra_monthly,
    }


def roi_routes(
    model: RoiModel, meetings: float, closed_deals: float
) -> list[dict[str, float | str]]:
    def route(name: str, monthly: float) -> dict[str, float | str]:
        return {
            "name": name,
            "monthly": monthly,
            "per_meeting": monthly / meetings if meetings > 0 else 0,
            "cac": monthly / closed_deals if closed_deals > 0 else 0,
        }

    return [
        route("In-house SDR", model["sdr_monthly"]),
        route("Lead agency", model["agency_monthly"]),
        route("Reachfold", model["reachfold_monthly"]),
    ]


def render_roi(inputs: RoiInputs, model: RoiModel) -> str:
    routes = roi_routes(model, inputs["meetings"], model["closed_deals"])
    plan = require_plan(inputs)
    emails = int_text(js_round(model["emails_month"]))
    deals = model["closed_deals"]
    route_rows = [
        [
            str(route["name"]),
            f"{usd(route['monthly'])}/mo",
            f"{usd_cents(route['per_meeting'])}/meeting",
            f"CAC {usd(js_round(route['cac']))}",
        ]
        for route in routes
    ]
    lines = [
        f"What {js_str(inputs['meetings'])} meetings/month requires",
        f"  Emails sent / month        {emails}",
        "  Leads in sequence / month  "
        f"{int_text(js_round(model['leads_month']))} leads, "
        f"{js_str(inputs['sequence_length'])} emails each",
        f"  Emails per sending day     {int_text(js_round(model['emails_day']))}",
        "  Domains                    "
        f"{model['domains']}  ({usd(inputs['domain_cost'])} one-time each, "
        f"about {usd(model['domains'] * inputs['domain_cost'])} setup)",
        "  Inboxes                    "
        f"{js_str(model['inboxes'])}  ({usd_cents(inputs['inbox_cost'])}/mo each)",
        f"  Daily send capacity        {int_text(model['daily_capacity'])}/day",
        "",
        "Funnel",
        f"  Emails sent    {emails}/mo",
        "  Replies        "
        f"{int_text(js_round(model['replies']))}/mo  ({js_str(inputs['reply_rate_pct'])}%)",
        "  Meetings       "
        f"{int_text(js_round(inputs['meetings']))}/mo  ({js_str(inputs['reply_to_meeting_pct'])}%)",
        "  Closed deals   "
        f"{to_fixed(deals, 1) + '/mo' if deals >= 1 else '< 1/mo'}  "
        f"({js_str(inputs['close_rate_pct'])}%)",
        f"  Revenue/mo     {usd(model['revenue_monthly'])}",
        f"  Booked-deal value per year  {usd(inputs['meetings'] * 12 * inputs['deal_value'])}",
        "",
        "What it costs (the same "
        f"{int_text(js_round(inputs['meetings']))} meetings/month, priced three ways)",
        *(f"  {line}" for line in align_rows(route_rows)),
        "",
        f"Reachfold route: {plan['name']} plan {usd(plan['price'])} + "
        f"{usd(model['infra_monthly'])} infra, plus send credits beyond the plan allotment.",
        "Estimates only, not a quote. Every number comes from your inputs.",
    ]
    return "\n".join(lines) + "\n"


def roi_to_json(inputs: RoiInputs, model: RoiModel) -> dict[str, object]:
    plan = require_plan(inputs)
    return {
        "inputs": {
            "meetings_per_month": inputs["meetings"],
            "deal_value": inputs["deal_value"],
            "sequence_length": inputs["sequence_length"],
            "reply_rate_pct": inputs["reply_rate_pct"],
            "reply_to_meeting_pct": inputs["reply_to_meeting_pct"],
            "close_rate_pct": inputs["close_rate_pct"],
            "sdr_meetings_per_month": inputs["sdr_meetings"],
            "sdr_cost_per_year": inputs["sdr_cost_year"],
            "agency_price_per_meeting": inputs["agency_per_meeting"],
            "plan": inputs["plan"],
            "plan_price_per_month": plan["price"],
            "domain_cost": inputs["domain_cost"],
            "inbox_cost": inputs["inbox_cost"],
            "daily_limit_per_inbox": inputs["daily_limit"],
            "inboxes_per_domain": inputs["inboxes_per_domain"],
            "sending_days_per_week": inputs["sending_days"],
            "warmup_buffer": WARMUP_BUFFER,
        },
        "emails_per_month": model["emails_month"],
        "leads_per_month": model["leads_month"],
        "emails_per_sending_day": model["emails_day"],
        "domains": model["domains"],
        "inboxes": model["inboxes"],
        "daily_capacity": model["daily_capacity"],
        "replies_per_month": model["replies"],
        "closed_deals_per_month": model["closed_deals"],
        "revenue_per_month": model["revenue_monthly"],
        "sdrs_needed": model["sdrs_needed"],
        "infra_per_month": model["infra_monthly"],
        "routes": roi_routes(model, inputs["meetings"], model["closed_deals"]),
        "booked_deal_value_per_year": inputs["meetings"] * 12 * inputs["deal_value"],
    }


def roi_option_help() -> dict[str, str]:
    """Help text of one ROI option, shared by argument parsing and ``roi --help``."""
    help_text = {"plan": "Reachfold plan: starter, growth, scale or agency (default growth)"}
    for spec in ROI_INPUTS:
        extra = "/month" if spec["flag"] == "meetings" else ""
        help_text[spec["flag"]] = (
            f"{spec['label']}{extra} (default {js_str(spec['fallback'])}{spec['unit']}; "
            f"calculator range {js_str(spec['min'])} to {js_str(spec['max'])})"
        )
    return help_text
