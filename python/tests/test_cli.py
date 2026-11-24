"""End-to-end subprocess tests: ``python -m cold_email_mcp`` with the same cases as Node."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO.parent / "fixtures"
ENV = {**os.environ, "PYTHONPATH": str(REPO / "src")}
BANNER = "Reachfold — AI SDR with human approval"


def run(*args: str, stdin: str | None = None, env: dict[str, str] | None = None):
    result = subprocess.run(
        [sys.executable, "-m", "cold_email_mcp", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        input=stdin,
        env={**ENV, **(env or {})},
        timeout=60,
        cwd=str(REPO),
    )
    return result.returncode, result.stdout, result.stderr


def test_help_lists_commands_and_exit_codes():
    code, out, _err = run("--help")
    assert code == 0
    for command in ("verify", "audit", "score", "permute", "roi"):
        assert command in out
    assert "Exit codes: 0 = success, 1 = network or API error" in out


def test_command_help():
    code, out, _err = run("roi", "--help")
    assert code == 0
    assert "--meetings" in out and "--plan" in out and "--no-banner" in out
    assert "--file" not in out


def test_version_from_package_metadata():
    from cold_email_mcp import __version__

    code, out, _err = run("--version")
    assert code == 0
    assert out.strip() == f"cold-email-mcp {__version__}"


def test_version_acts_before_a_later_unknown_option_only():
    code, out, _err = run("--version", "--bogus")
    assert code == 0
    code, _out, err = run("--bogus", "--version")
    assert code == 2
    assert "Unknown option" in err


def test_banner_after_success_on_stderr_only():
    code, out, err = run("permute", "--first", "Jane", "--last", "Doe")
    assert code == 0
    assert "jane.doe" in out
    assert BANNER in err
    assert "utm_source=cli" in err
    assert BANNER not in out
    assert "free tier" not in err and "inbox" not in err


def test_no_banner_flag_and_env_var():
    code, _out, err = run("permute", "--first", "J", "--last", "D", "--no-banner")
    assert code == 0 and err == ""
    code, _out, err = run(
        "permute", "--first", "J", "--last", "D", env={"OUTBOUND_UTILS_NO_BANNER": "1"}
    )
    assert code == 0 and err == ""


def test_permute_json_with_cyrillic_names():
    code, out, _err = run(
        "permute",
        "--json",
        "--first",
        "Иван",
        "--last",
        "Пётр",
        "--domain",
        "acme.com",
        "--no-banner",
    )
    assert code == 0
    parsed = json.loads(out)
    assert sum(1 for item in parsed if item["most_common"]) == 1
    assert any(item["value"] == "ivan.petr@acme.com" for item in parsed)


def test_roi_human_output_matches_fixture_defaults():
    code, out, _err = run("roi", "--no-banner")
    assert code == 0
    assert "2,667" in out and "$10,833" in out and "$179" in out
    assert "Estimates only" in out


def test_roi_json_matches_fixture():
    code, out, _err = run("roi", "--json", "--no-banner")
    assert code == 0
    fixture = json.loads((FIXTURES / "roi.json").read_text(encoding="utf-8"))
    assert json.loads(out) == fixture["cases"][0]["expected"]


USAGE_CASES = [
    (),
    ("no-such-command",),
    ("verify",),
    ("audit", "bad_domain"),
    ("verify", "not-an-email"),
    ("permute", "--first", "Jane"),
    ("permute", "--first", "###", "--last", "Doe"),
    ("score",),
    ("score", "--subject", "x", "file.txt"),
    ("score", "file.txt", "--subject", "x"),
    ("roi", "--meetings", "abc"),
    ("roi", "--meetings", "-5"),
    ("roi", "--plan", "free"),
    ("roi", "--reply-rate", "150"),
    ("verify", "a@b.com", "--bogus"),
    ("audit", "acme.com", "--file"),
    ("audit", "acme.com", "--json=yes"),
    ("permute", "--first", "J", "--last", "D", "--meetings", "5"),
]


@pytest.mark.parametrize("args", USAGE_CASES, ids=lambda args: " ".join(args) or "(no args)")
def test_usage_errors_exit_2(args):
    code, _out, err = run(*args)
    assert code == 2, err
    assert err.startswith("Error: ")
    assert "\n    at " not in err, "no stack trace"


def test_file_input_skips_invalid_lines_and_exits_1():
    code, out, err = run(
        "audit", "--file", str(FIXTURES / "audit-domains.txt"), "--base-url", "http://127.0.0.1:1"
    )
    assert code == 1
    assert 'line 3: skipped, not a valid domain: "not_a_domain"' in err
    assert "Auditing 1/3" in err
    assert out == ""


def test_stdin_via_file_dash():
    code, _out, err = run(
        "audit", "--file", "-", "--base-url", "http://127.0.0.1:1", stdin="acme.com\nexample.com\n"
    )
    assert code == 1
    assert "Auditing 1/2: acme.com" in err


def test_missing_file_is_a_usage_error():
    code, _out, err = run("audit", "--file", "Z:/no/such/file.txt")
    assert code == 2
    assert "Cannot read file" in err


def test_all_invalid_file_exits_1():
    code, _out, err = run("audit", "--file", str(FIXTURES / "score-sample.txt"))
    assert code == 1
    assert "No valid domain to check" in err
