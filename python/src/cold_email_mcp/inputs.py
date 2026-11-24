"""Client-side validation and input files, shared by the network commands."""

from __future__ import annotations

import errno
import math
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from urllib.parse import urlsplit

from .base import DEFAULT_BASE_URL, PROGRAM_NAME, CliError, Streams, UsageError, js_trim

# JavaScript's \s and trim(): str.strip() and Python's \s use a different character set.
_JS_SPACE = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

# Same shape checks as the API, so bad input fails before any request is sent.
EMAIL_RE = re.compile(rf"^[^{_JS_SPACE}@]+@[^{_JS_SPACE}@]+\.[^{_JS_SPACE}@]+\Z")
DOMAIN_RE = re.compile(r"[a-z0-9.-]+\.[a-z]{2,}")
# One unambiguous number syntax in both packages (no hex, underscores, NaN).
NUMBER_RE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\Z")
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
_HOST = re.compile(r"(?:[a-z0-9._~-]+|\[[0-9a-f:.]+])\Z", re.IGNORECASE)

LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
READ_REASONS = {
    errno.ENOENT: "no such file or directory",
    errno.EISDIR: "is a directory",
    errno.EACCES: "permission denied",
    errno.EPERM: "permission denied",
}


def normalize_email(raw: str) -> str:
    return js_trim(raw).lower()


def is_email(email: str) -> bool:
    return EMAIL_RE.match(email) is not None


def normalize_domain(raw: str) -> str:
    """Same cleanup as the API: scheme, path and case are dropped."""
    value = re.sub(r"^https?://", "", js_trim(raw).lower(), count=1)
    return value.partition("/")[0]


def is_domain(domain: str) -> bool:
    return len(domain) <= 253 and DOMAIN_RE.fullmatch(domain) is not None


def parse_number(flag: str, raw: str) -> float:
    text = js_trim(raw)
    if NUMBER_RE.fullmatch(text) is None:
        raise UsageError(f'--{flag} must be a number, got "{raw}".')
    value = float(text)
    if not math.isfinite(value):
        raise UsageError(f'--{flag} must be a finite number, got "{raw}".')
    return value


def read_text(streams: Streams, path: str) -> str:
    """A text file as UTF-8 with LF line endings and no BOM."""
    try:
        text = streams.read_text_file(path)
    except UsageError:
        raise
    except UnicodeDecodeError:
        raise UsageError(f'Cannot read file "{path}": not UTF-8 text.') from None
    except (OSError, ValueError) as exc:
        # Windows reports a directory as "permission denied"; name the real problem.
        reason = (
            "is a directory"
            if Path(path).is_dir()
            else READ_REASONS.get(getattr(exc, "errno", None), "read error")
        )
        raise UsageError(f'Cannot read file "{path}": {reason}.') from None
    return text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")


def parse_lines(text: str) -> list[tuple[int, str]]:
    """Non-empty trimmed lines with their 1-based numbers."""
    result: list[tuple[int, str]] = []
    for number, raw_line in enumerate(text.split("\n"), start=1):
        line = js_trim(raw_line)
        if line:
            result.append((number, line))
    return result


def collect_items(
    streams: Streams,
    command: str,
    kind: str,
    argv: Sequence[str],
    file: str | None,
    normalize: Callable[[str], str],
    is_valid: Callable[[str], bool],
) -> tuple[list[str], list[tuple[int, str]]]:
    """Items from argv and/or --file. A bad argv item is a usage error (exit 2);
    a bad line in a file is skipped with a warning and reported through exit code 1."""
    values: list[str] = []
    for raw in argv:
        value = normalize(raw)
        if not is_valid(value):
            raise UsageError(f'Not a valid {kind}: "{js_trim(raw)}".')
        values.append(value)

    skipped: list[tuple[int, str]] = []
    if file is not None:
        name = "stdin" if file == "-" else file
        for number, line in parse_lines(read_text(streams, file)):
            value = normalize(line)
            if is_valid(value):
                values.append(value)
            else:
                skipped.append((number, line))
                streams.stderr(f'{name}, line {number}: skipped, not a valid {kind}: "{line}"\n')

    if not values:
        if skipped:
            raise CliError(
                f'No valid {kind} to check: all {len(skipped)} line(s) of "{file}" were skipped.'
            )
        hint = f"{PROGRAM_NAME} {command} --help"
        raise UsageError(f"Provide at least one {kind} or pass --file <path>. Run " + f'"{hint}".')
    return values, skipped


def _strip_final_newline(text: str) -> str:
    return text[:-1] if text.endswith("\n") else text


_SUBJECT_BLANK_BODY = re.compile(r"^([^\n]*)\n[ \t]*\n([\s\S]*)\Z", re.DOTALL)


def split_email_file(text: str) -> tuple[str, str]:
    """A positional file is "subject", one blank line, then the body.
    Without the blank line the whole file is the body. Returns ``(subject, body)``."""
    match = _SUBJECT_BLANK_BODY.match(text)
    if match is None:
        return "", _strip_final_newline(text)
    return match.group(1).strip(), _strip_final_newline(match.group(2))


def body_from_file(text: str) -> str:
    return _strip_final_newline(text)


def normalize_base_url(raw: str | None) -> str:
    """Validates --base-url. Plain http is allowed only on the local machine."""
    given = js_trim(raw or "")
    value = given if given else DEFAULT_BASE_URL
    with_scheme = value if _SCHEME.match(value) else f"https://{value}"
    parts = urlsplit(with_scheme)
    try:
        port = parts.port
    except ValueError:
        raise UsageError(f'--base-url "{value}" is not a valid URL.') from None
    local = parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS
    if parts.scheme != "https" and not local:
        raise UsageError(
            f'--base-url must use https (http is allowed only for localhost): "{value}".'
        )
    host = parts.hostname or ""
    if (
        parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.path not in {"", "/"}
        or _HOST.fullmatch(host) is None
    ):
        raise UsageError(
            f"--base-url must be an origin without path, query or credentials, "
            f'e.g. "{DEFAULT_BASE_URL}".'
        )
    shown = f"[{host}]" if ":" in host else host
    default_port = 443 if parts.scheme == "https" else 80
    suffix = f":{port}" if port is not None and port != default_port else ""
    return f"{parts.scheme}://{shown}{suffix}"
