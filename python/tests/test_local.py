"""Offline command tests against the shared fixtures (same files as the Node package)."""

import json
from pathlib import Path

import pytest

from cold_email_mcp.base import UsageError, int_text, js_round, to_fixed, usd, usd_cents
from cold_email_mcp.inputs import (
    body_from_file,
    is_domain,
    is_email,
    normalize_domain,
    normalize_email,
    parse_number,
    split_email_file,
)
from cold_email_mcp.local import (
    PLANS,
    clean_domain,
    compute_roi,
    default_roi_inputs,
    normalize_name,
    permute,
)

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
PERMUTATION_CASES = json.loads((FIXTURES / "permutations.json").read_text(encoding="utf-8"))[
    "cases"
]
ROI_CASES = json.loads((FIXTURES / "roi.json").read_text(encoding="utf-8"))["cases"]

FIELD_BY_FLAG = {
    "meetings": "meetings",
    "deal-value": "deal_value",
    "sequence-length": "sequence_length",
    "reply-rate": "reply_rate_pct",
    "reply-to-meeting": "reply_to_meeting_pct",
    "close-rate": "close_rate_pct",
    "sdr-meetings": "sdr_meetings",
    "sdr-cost": "sdr_cost_year",
    "agency-per-meeting": "agency_per_meeting",
    "domain-cost": "domain_cost",
    "inbox-cost": "inbox_cost",
    "daily-limit": "daily_limit",
    "inboxes-per-domain": "inboxes_per_domain",
    "sending-days": "sending_days",
}


@pytest.mark.parametrize("case", PERMUTATION_CASES, ids=lambda case: case["name"])
def test_permute_matches_fixture(case):
    result = permute(case["first"], case["last"], case["domain"])
    assert [item["value"] for item in result] == case["expected"]
    host = clean_domain(case["domain"])
    if host:
        assert all(item["value"].endswith(f"@{host}") for item in result)
        assert sum(1 for item in result if item["most_common"]) == 1


def test_name_and_domain_cleanup_matches_the_web_tool():
    assert normalize_name("  ИВАН ") == "ivan"
    assert normalize_name("O'Brien!") == "obrien"
    assert clean_domain("HTTPS://Sub.Acme.COM/path/") == "sub.acme.com"
    assert clean_domain("@acme.com") == "acme.com"


def _inputs_from_case(case):
    inputs = default_roi_inputs()
    for flag, raw in case["inputs"].items():
        if flag == "plan":
            inputs["plan"] = raw
            continue
        inputs[FIELD_BY_FLAG[flag]] = float(raw)
    return inputs


@pytest.mark.parametrize("case", ROI_CASES, ids=lambda case: case["name"])
def test_roi_matches_generated_fixture(case):
    from cold_email_mcp.local import plan_by_id, roi_routes

    inputs = _inputs_from_case(case)
    model = compute_roi(inputs)
    plan = plan_by_id(inputs["plan"])
    actual = {
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
            "warmup_buffer": 1.5,
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
    assert actual == case["expected"]


def test_numbers_render_like_the_web_calculator():
    from cold_email_mcp.local import compute_roi as compute

    model = compute(default_roi_inputs())
    assert int_text(js_round(model["emails_month"])) == "2,667"
    assert usd(model["sdr_monthly"]) == "$10,833"
    assert usd_cents(model["infra_monthly"] / model["inboxes"]) == "$4.04"
    assert to_fixed(model["closed_deals"], 1) == "2.0"


def test_zero_rate_matches_the_web_tool_site_fixture():
    inputs = default_roi_inputs() | {"reply_rate_pct": 0.0, "close_rate_pct": 0.0}
    model = compute_roi(inputs)
    assert model["emails_month"] == 0
    assert model["domains"] == 1
    assert model["inboxes"] == 2
    assert model["daily_capacity"] == 80
    assert model["closed_deals"] == 0
    other = compute_roi(default_roi_inputs() | {"reply_to_meeting_pct": 0.0})
    assert other["emails_month"] == 0
    assert other["closed_deals"] == 2


def test_plan_prices_match_the_web_calculator():
    assert [plan["price"] for plan in PLANS] == [59, 139, 274, 549]


def test_validation_matches_the_api():
    assert is_email("test@gmail.com")
    assert not is_email("not-an-email")
    assert not is_email("a@b")
    assert normalize_email("  Test@GMAIL.Com ") == "test@gmail.com"
    assert is_domain(normalize_domain("https://Sub.Acme.com/path"))
    assert not is_domain("bad_domain")
    assert not is_domain("localhost")


def test_parse_number_rejects_non_numbers():
    assert parse_number("meetings", "25") == 25
    with pytest.raises(UsageError):
        parse_number("meetings", "abc")
    with pytest.raises(UsageError):
        parse_number("meetings", "0x10")


def test_split_email_file_on_the_first_blank_line():
    assert split_email_file("Subject line\n\nBody here") == ("Subject line", "Body here")
    assert split_email_file("No blank line") == ("", "No blank line")
    assert split_email_file("Subject\n\n\nBody") == ("Subject", "\nBody")
    assert body_from_file("Body\n") == "Body"
