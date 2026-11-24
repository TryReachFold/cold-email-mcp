"""The five commands. Results go to stdout, everything else to stderr."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from .base import (
    EXIT_FAILURE,
    EXIT_OK,
    ApiError,
    Streams,
    UsageError,
    as_object,
    js_numbers,
    js_str,
    js_trim,
    json_string_list,
    one_line,
    render_table,
)
from .http import (
    DEFAULT_HTTP_SETTINGS,
    HttpResult,
    HttpSettings,
    create_api_context,
    describe_failure,
    is_success,
    parse_success,
    request_each,
)
from .inputs import (
    body_from_file,
    collect_items,
    is_domain,
    is_email,
    normalize_domain,
    normalize_email,
    parse_number,
    read_text,
    split_email_file,
)
from .local import (
    PLANS,
    ROI_INPUTS,
    RoiInputs,
    compute_roi,
    default_roi_inputs,
    normalize_name,
    permute,
    plan_by_id,
    render_roi,
    roi_to_json,
)

VERIFY_HEADERS = ("EMAIL", "STATUS", "REASON", "FLAGS")


def _finish(streams: Streams, failed: int, skipped: int) -> int:
    """Exit code 1 when anything was skipped or failed; the summary itself is service output."""
    if failed == 0 and skipped == 0:
        return EXIT_OK
    streams.stderr(f"Finished with problems: {failed} failed, {skipped} skipped as invalid.\n")
    return EXIT_FAILURE


def _emit_compact_json(streams: Streams, value: Any) -> None:
    streams.stdout(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def _verify_row(email: str, data: Any) -> list[str]:
    record: dict[str, Any] = as_object(data) or {}

    def text(key: str) -> str:
        value = record.get(key)
        return one_line(value) if isinstance(value, str) else ""

    flags = json_string_list(record.get("flags"))
    return [email, text("status") or "unknown", text("reason"), ", ".join(flags) if flags else "-"]


def render_audit(domain: str, data: Any) -> str:
    """Relies on domain, score and issues only; every other field is optional."""
    record: dict[str, Any] = as_object(data) or {}
    reported = record.get("domain")
    name = reported if isinstance(reported, str) and reported else domain
    score = record.get("score")
    lines = [f"{name}: score {score if isinstance(score, (int, float)) else 'n/a'}/100"]
    issues = record.get("issues")
    if not isinstance(issues, list):
        lines.append("  Issues: not reported by the server")
    elif not issues:
        lines.append("  No issues found")
    else:
        lines.append("  Issues:")
        for issue in (as_object(item) or {} for item in issues):
            severity = one_line(str(issue.get("severity", "?")))
            issue_id = one_line(str(issue.get("id", "?")))
            lines.append(f"    [{severity}] {issue_id}: {one_line(str(issue.get('fix', '?')))}")
    return "\n".join(lines) + "\n"


def audit_caveats(data: Any) -> list[str]:
    """What the tool does not check is service information: it goes to stderr."""
    record = as_object(data) or {}
    not_checked = json_string_list(record.get("not_checked"))
    notes = json_string_list(record.get("notes"))
    return [
        line
        for line in (
            f"Not checked by this tool: {'; '.join(not_checked)}" if not_checked else "",
            f"Notes: {'; '.join(notes)}" if notes else "",
        )
        if line
    ]


def _render_score(data: Any) -> str:
    record: dict[str, Any] = as_object(data) or {}
    score = record.get("spam_score")
    verdict = record.get("verdict")
    lines = [
        f"Spam score: {score if isinstance(score, (int, float)) else 'n/a'}/100 "
        f"({verdict if isinstance(verdict, str) else 'unknown'})",
        "Triggers:",
    ]
    raw_triggers = record.get("triggers")
    triggers = (
        [as_object(item) or {} for item in raw_triggers] if isinstance(raw_triggers, list) else []
    )
    if not triggers:
        lines.append("  none")
    for trigger in triggers:
        points = trigger.get("points")
        shown = str(points) if isinstance(points, (int, float)) else "?"
        phrase = one_line(str(trigger.get("phrase", "")))
        lines.append(f"  {shown:>3}  {phrase}")
    checked = record.get("checked_chars")
    if isinstance(checked, int):
        lines.append(f"Checked {checked} characters")
    return "\n".join(lines) + "\n"


def run_verify(
    items: Sequence[str],
    file: str | None,
    base_url: str | None,
    json_output: bool,
    streams: Streams,
    settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
) -> int:
    values, skipped = collect_items(
        streams, "verify", "email", items, file, normalize_email, is_email
    )
    ctx = create_api_context(base_url, json_output, streams, settings)
    rows: list[list[str]] = []
    failed = 0
    try:
        for event in request_each(
            ctx, "/api/tools/verify-email", values, lambda email: {"email": email}, "Checking"
        ):
            if event.error is not None:
                failed += 1
                streams.stderr(f"FAILED {event.item}: {event.error.message}\n")
            elif ctx.json_output:
                streams.stdout(f"{event.raw}\n")
            else:
                rows.append(_verify_row(event.item, event.data))
    finally:
        # Results collected so far stay readable when a later request aborts the batch.
        if not ctx.json_output and rows:
            streams.stdout(render_table(VERIFY_HEADERS, rows))
    return _finish(streams, failed, len(skipped))


def run_audit(
    items: Sequence[str],
    file: str | None,
    base_url: str | None,
    json_output: bool,
    streams: Streams,
    settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
) -> int:
    values, skipped = collect_items(
        streams, "audit", "domain", items, file, normalize_domain, is_domain
    )
    ctx = create_api_context(base_url, json_output, streams, settings)
    failed = 0
    for event in request_each(
        ctx, "/api/tools/dns-audit", values, lambda domain: {"domain": domain}, "Auditing"
    ):
        if event.error is not None:
            failed += 1
            streams.stderr(f"FAILED {event.item}: {event.error.message}\n")
            continue
        if ctx.json_output:
            streams.stdout(f"{event.raw}\n")
        else:
            separator = "\n" if len(values) > 1 else ""
            streams.stdout(f"{render_audit(event.item, event.data)}{separator}")
        for line in audit_caveats(event.data):
            streams.stderr(f"{line}\n")
    return _finish(streams, failed, len(skipped))


def run_score(
    files: Sequence[str],
    subject_option: str | None,
    body_file: str | None,
    base_url: str | None,
    json_output: bool,
    streams: Streams,
    settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
) -> int:
    if len(files) > 1:
        raise UsageError("score takes one <file>, or --subject with --body-file.")
    file = files[0] if files else None
    if file is not None and (body_file is not None or subject_option is not None):
        raise UsageError("Pass either a <file> or --subject/--body-file, not both.")
    if file is not None:
        subject, body = split_email_file(read_text(streams, file))
    else:
        subject = js_trim(subject_option or "")
        body = body_from_file(read_text(streams, body_file)) if body_file is not None else ""
    if not subject and not js_trim(body):
        raise UsageError("Nothing to score: provide --subject and/or --body-file, or a <file>.")

    ctx = create_api_context(base_url, json_output, streams, settings)
    result: HttpResult = ctx.client.post(
        "/api/tools/spam-score", {"subject": subject, "body": body}
    )
    if not is_success(result.status):
        raise ApiError(describe_failure(result, ctx.host), result.status)
    if ctx.json_output:
        streams.stdout(f"{result.body.strip()}\n")
    else:
        streams.stdout(_render_score(parse_success(result, ctx.host)))
    return EXIT_OK


def run_permute(
    first: str | None, last: str | None, domain: str | None, json_output: bool, streams: Streams
) -> int:
    if first is None or last is None:
        raise UsageError('--first and --last are required. Run "cold-email-mcp permute --help".')
    for flag, value in (("--first", first), ("--last", last)):
        if not normalize_name(value):
            raise UsageError(
                f'{flag} "{value}" has no letters left after cleanup: '
                "only Latin and Cyrillic letters are kept."
            )
    result = permute(first, last, domain or "")
    if json_output:
        _emit_compact_json(streams, result)
    else:
        streams.stdout("\n".join(item["value"] for item in result) + "\n")
    return EXIT_OK


def parse_roi_options(options: Mapping[str, str | None]) -> tuple[RoiInputs, list[str]]:
    inputs = default_roi_inputs()
    warnings: list[str] = []
    for spec in ROI_INPUTS:
        raw = options[spec["flag"]]
        if raw is None:
            continue
        value = parse_number(spec["flag"], raw)
        flag = f"--{spec['flag']}"
        if (spec["positive"] and value <= 0) or value < 0:
            bound = "greater than" if spec["positive"] else "at least"
            raise UsageError(f"{flag} must be {bound} 0, got {raw}.")
        if spec["integer"] and not value.is_integer():
            raise UsageError(f"{flag} must be a whole number, got {raw}.")
        if spec["unit"] == "%" and value > 100:
            raise UsageError(f"{flag} is a percentage and cannot exceed 100, got {raw}.")
        if value < spec["min"] or value > spec["max"]:
            warnings.append(
                f"Warning: {flag} {raw} is outside the calculator range "
                f"{js_str(spec['min'])} to {js_str(spec['max'])}; the estimate may be unrealistic."
            )
        inputs[spec["field"]] = value
    plan_name = options["plan"]
    if plan_name is not None:
        plan_id = js_trim(plan_name).lower()
        if plan_by_id(plan_id) is None:
            names = ", ".join(str(plan["id"]) for plan in PLANS)
            raise UsageError(f'--plan must be one of {names}, got "{plan_name}".')
        inputs["plan"] = plan_id
    return inputs, warnings


def run_roi(options: Mapping[str, str | None], json_output: bool, streams: Streams) -> int:
    inputs, warnings = parse_roi_options(options)
    for warning in warnings:
        streams.stderr(f"{warning}\n")
    model = compute_roi(inputs)
    if json_output:
        streams.stdout(
            json.dumps(js_numbers(roi_to_json(inputs, model)), ensure_ascii=False, indent=2) + "\n"
        )
    else:
        streams.stdout(render_roi(inputs, model))
    return EXIT_OK
