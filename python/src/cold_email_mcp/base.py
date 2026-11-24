"""Shared building blocks: constants, errors, streams and output formats."""

from __future__ import annotations

import io
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

PROGRAM_NAME = "cold-email-mcp"
DEFAULT_BASE_URL = "https://tryreachfold.com"

EXIT_OK = 0
EXIT_FAILURE = 1  # network or API error, skipped input lines
EXIT_USAGE = 2  # invalid arguments

EXIT_CODES_HELP = (
    "Exit codes: 0 = success, 1 = network or API error"
    " (or skipped input lines), 2 = invalid arguments."
)

# Facts only: what the product is and where the waitlist is.
BANNER = (
    "Reachfold — AI SDR with human approval. Waitlist: "
    "https://tryreachfold.com/?utm_source=cli&utm_medium=referral&utm_campaign=waitlist-launch"
)


class CliError(Exception):
    """An error reported to the user as one line, without a stack trace."""

    def __init__(self, message: str, exit_code: int = EXIT_FAILURE) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code


class UsageError(CliError):
    """The command line itself is wrong: unknown option, bad value, missing input."""

    def __init__(self, message: str) -> None:
        super().__init__(message, EXIT_USAGE)


class ApiError(CliError):
    """The tool API answered with a status that retrying will not fix."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def should_show_banner(no_banner_flag: bool, env: Mapping[str, str]) -> bool:
    if no_banner_flag:
        return False
    value = env.get("OUTBOUND_UTILS_NO_BANNER", "").strip().lower()
    return value not in {"1", "true"}


def first_line(err: BaseException) -> str:
    return str(err).split("\n", 1)[0].strip()


@dataclass(frozen=True)
class Streams:
    """All I/O of the CLI, injectable so tests never touch the real streams."""

    stdout: Callable[[str], None]
    """Machine-readable output: nothing but results goes here."""
    stderr: Callable[[str], None]
    """Service output: warnings, progress, retry notices, the closing banner."""
    env: Mapping[str, str]
    read_text_file: Callable[[str], str]
    """Read a UTF-8 text file ("-" = stdin). Raises on failure."""


def _read_system_text(path: str) -> str:
    if path != "-":
        return Path(path).read_text(encoding="utf-8")
    if sys.stdin.isatty():
        raise UsageError('"-" reads from stdin, but stdin is a terminal. Pipe a file in instead.')
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    return sys.stdin.read()


def system_streams() -> Streams:
    # Windows pipes default to the locale code page; the banner alone contains an em dash.
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="replace")
    return Streams(
        stdout=sys.stdout.write,
        stderr=sys.stderr.write,
        env=os.environ,
        read_text_file=_read_system_text,
    )


# --- Text and JSON helpers ---------------------------------------------------

# Character set of JavaScript trim() and its whitespace class; str.strip() differs.
JS_WHITESPACE = "".join(
    chr(code)
    for code in (
        0x09,
        0x0A,
        0x0B,
        0x0C,
        0x0D,
        0x20,
        0xA0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
        0xFEFF,
    )
)


def js_trim(value: str) -> str:
    return value.strip(JS_WHITESPACE)


def one_line(text: str) -> str:
    """Server text may contain line breaks; one table cell is always one line."""
    return re.sub(r"\s+", " ", text).strip()


def truncate(text: str, max_length: int) -> str:
    if len(text) > max_length:
        return f"{text[: max_length - 3]}..."
    return text


def as_object(value: Any) -> dict[str, Any] | None:
    """A JSON object as the API returns it: every field is optional at run time."""
    return value if isinstance(value, dict) else None


def json_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def align_rows(rows: Sequence[Sequence[str]]) -> list[str]:
    """Left-aligns columns with two spaces between them (rows may differ in length)."""
    if not rows:
        return []
    columns = max(len(row) for row in rows)
    widths = [max(len(row[i]) if i < len(row) else 0 for row in rows) for i in range(columns)]
    return ["  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows]


def render_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    return "\n".join([*align_rows([headers]), *align_rows(rows)]) + "\n"


# --- Number formats of the web calculator, so both CLIs show the same digits ---


def js_round(value: float) -> int:
    """JavaScript ``Math.round``: floor(value + 0.5) on the exact binary value."""
    return int((Decimal(value) + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR))


def js_str(value: float) -> str:
    """Number to text the way JavaScript prints it: no trailing ``.0`` on whole numbers."""
    if value.is_integer() and abs(value) < 1e16:
        return str(int(value))
    return repr(value)


def int_text(value: float) -> str:
    """``Intl.NumberFormat("en-US", {maximumFractionDigits: 0})``: V8 rounds the shortest
    decimal form of the double, ties away from zero."""
    rounded = Decimal(repr(value)).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return f"{rounded:,.0f}"


def usd(value: float) -> str:
    return f"${int_text(value)}"


def usd_cents(value: float) -> str:
    rounded = Decimal(repr(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"${rounded:,.2f}"


def to_fixed(value: float, digits: int) -> str:
    """JavaScript ``toFixed``: the exact binary value, ties away from zero, no grouping."""
    rounded = Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return f"{rounded:.{digits}f}"


def js_numbers(value: Any) -> Any:
    """Whole-valued floats as integers, so JSON output matches JavaScript's ``JSON.stringify``."""

    def convert(item: Any) -> Any:
        if isinstance(item, float) and item.is_integer() and abs(item) < 1e21:
            return int(item)
        if isinstance(item, dict):
            return {key: convert(inner) for key, inner in item.items()}
        if isinstance(item, list):
            return [convert(inner) for inner in item]
        return item

    return convert(value)
