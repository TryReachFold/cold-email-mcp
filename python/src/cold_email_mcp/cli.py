"""Command-line entry point: argument parsing, help texts and the closing banner."""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any

from . import __version__
from .base import (
    BANNER,
    DEFAULT_BASE_URL,
    EXIT_CODES_HELP,
    EXIT_FAILURE,
    EXIT_OK,
    PROGRAM_NAME,
    CliError,
    Streams,
    first_line,
    should_show_banner,
    system_streams,
)
from .commands import run_audit, run_permute, run_roi, run_score, run_verify
from .http import DEFAULT_HTTP_SETTINGS, HttpSettings
from .local import ROI_FLAGS, roi_option_help

# Type of every option the CLI knows, so one flag is never parsed two ways.
STRING_OPTIONS = frozenset(
    {"file", "base-url", "subject", "body-file", "first", "last", "domain", *ROI_FLAGS}
)
BOOL_OPTIONS = frozenset({"json", "no-banner"})
BUILTIN_OPTIONS = frozenset({"help", "version"})
ALL_OPTIONS = STRING_OPTIONS | BOOL_OPTIONS | BUILTIN_OPTIONS

PLACEHOLDERS: Mapping[str, str] = {
    "base-url": "<url>",
    "body-file": "<path>",
    "domain": "<domain>",
    "file": "<path>",
    "first": "<name>",
    "last": "<name>",
    "plan": "<name>",
    "subject": "<text>",
}

SHARED_NO_BANNER = "Skip the closing waitlist line (or set OUTBOUND_UTILS_NO_BANNER=1)"
NETWORK_OPTIONS: Mapping[str, str] = {
    "base-url": f"API base URL (default: {DEFAULT_BASE_URL})",
    "json": "Print the raw JSON response to stdout, one JSON document per line",
    "no-banner": SHARED_NO_BANNER,
}
LOCAL_OPTIONS: Mapping[str, str] = {
    "json": "Print the result as JSON to stdout",
    "no-banner": SHARED_NO_BANNER,
}


@dataclass(frozen=True)
class CommandSpec:
    name: str
    summary: str
    usage: str
    argument_help: tuple[str, ...]
    description: tuple[str, ...]
    options: Mapping[str, str]


COMMAND_SPECS: tuple[CommandSpec, ...] = (
    CommandSpec(
        name="verify",
        summary="Check the syntax, domain and MX records of email addresses.",
        usage="[<email...>]",
        argument_help=("<email...>   One or more email addresses",),
        description=(
            "DNS-stage check only: there is no SMTP handshake, so an existing mailbox is",
            "not confirmed and catch-all domains are not detected.",
        ),
        options={
            "file": 'Read one email per line from <path> ("-" = stdin); adds to <email...>',
            **NETWORK_OPTIONS,
        },
    ),
    CommandSpec(
        name="audit",
        summary="Grade the email DNS setup of a domain (SPF, DKIM, DMARC, MX).",
        usage="[<domain...>]",
        argument_help=("<domain...>   One or more domains, e.g. acme.com",),
        description=(
            "Reads DNS records only: no sending-IP blacklist check, no inbox placement test.",
            '"DKIM not found" means the selector is not on the checked list,'
            " not that DKIM is unset.",
        ),
        options={
            "file": 'Read one domain per line from <path> ("-" = stdin); adds to <domain...>',
            **NETWORK_OPTIONS,
        },
    ),
    CommandSpec(
        name="score",
        summary="Score an email subject and body for spam-trigger words.",
        usage="[<file>]",
        argument_help=(
            "<file>   Text file: subject, one blank line, body. "
            "Without the blank line the whole file is the body.",
        ),
        description=(
            "A deterministic word and pattern heuristic. It is not SpamAssassin and does not",
            "predict the filters of Gmail or Outlook.",
        ),
        options={
            "subject": "Email subject line",
            "body-file": 'Read the email body from <path> ("-" = stdin)',
            **NETWORK_OPTIONS,
        },
    ),
    CommandSpec(
        name="permute",
        summary="Generate corporate email patterns from a first and last name (offline).",
        usage="",
        argument_help=(),
        description=(
            "Cyrillic names are transliterated. The patterns are guesses, not verified addresses.",
            "Without --domain only the local parts are printed.",
        ),
        options={
            "first": "First name (required)",
            "last": "Last name (required)",
            "domain": "Company domain, e.g. acme.com",
            **LOCAL_OPTIONS,
        },
    ),
    CommandSpec(
        name="roi",
        summary="Estimate what a meetings-per-month target costs, three ways (offline).",
        usage="",
        argument_help=(),
        description=(
            "Arithmetic on your own inputs: an in-house SDR, a lead agency and Reachfold.",
            "Estimates only, not a quote.",
        ),
        options={**roi_option_help(), **LOCAL_OPTIONS},
    ),
)


@dataclass(frozen=True)
class Invocation:
    action: str  # "help" | "version" | "run"
    command: CommandSpec | None = None
    options: Mapping[str, Any] = dataclass_field(default_factory=dict)
    positionals: tuple[str, ...] = ()


class _Missing:
    """Sentinel for an option that reached the end of the line without a value."""


_MISSING = _Missing()


def _scan(argv: Sequence[str]) -> list[tuple[int, str, str, Any]]:
    """A loose pass over the line: option events with positions, or positionals.
    Known string options and unknown options consume the next token as their value."""
    events: list[tuple[int, str, str, Any]] = []
    index = 0
    terminated = False
    while index < len(argv):
        arg = argv[index]
        if terminated:
            events.append((index, "positional", "", arg))
            index += 1
            continue
        if arg == "--":
            terminated = True
            index += 1
            continue
        if arg.startswith("--") and len(arg) > 2:
            name, _, inline = arg[2:].partition("=")
            events.append((index, "option", name, inline if _ else None))
            if not _ and (name in STRING_OPTIONS or name not in ALL_OPTIONS):
                # A space-separated value belongs to the option, whatever it says.
                if index + 1 < len(argv):
                    events.append((index + 1, "value", name, argv[index + 1]))
                else:
                    events.append((index + 1, "value", name, _MISSING))
                index += 2
            else:
                index += 1
            continue
        events.append((index, "positional", "", arg))
        index += 1
    return events


def _command_for(name: str) -> CommandSpec | None:
    return next((spec for spec in COMMAND_SPECS if spec.name == name), None)


def parse_command_line(argv: Sequence[str]) -> Invocation:
    events = _scan(argv)
    unknown = next(
        (event for event in events if event[1] == "option" and event[2] not in ALL_OPTIONS), None
    )
    builtin = next(
        (event for event in events if event[1] == "option" and event[2] in BUILTIN_OPTIONS), None
    )
    command_event = next((event for event in events if event[1] == "positional"), None)

    # --help and --version act the moment they are read, unless an unknown option comes first.
    if builtin is not None and (unknown is None or builtin[0] < unknown[0]):
        if builtin[2] == "help":
            scoped = command_event is not None and command_event[0] < builtin[0]
            return Invocation("help", _command_for(command_event[3]) if scoped else None)
        if command_event is None or builtin[0] < command_event[0]:
            return Invocation("version")
    if unknown is not None:
        raise CliError(
            f'Unknown option "--{unknown[2]}". Run "{PROGRAM_NAME} --help".',
            2,
        )
    if command_event is None:
        raise CliError(
            f'Missing command. Run "{PROGRAM_NAME} --help" to list the commands.',
            2,
        )
    spec = _command_for(str(command_event[3]))
    if spec is None:
        raise CliError(
            f'Unknown command "{command_event[3]}". '
            f'Run "{PROGRAM_NAME} --help" to list the commands.',
            2,
        )

    values: dict[str, Any] = {}
    for _position, kind, name, value in events:
        if kind == "positional":
            continue
        if kind == "option":
            if name == "help":
                continue
            if name not in spec.options:
                raise CliError(
                    f'Option "--{name}" is not supported by "{spec.name}". '
                    f'Run "{PROGRAM_NAME} {spec.name} --help".',
                    2,
                )
            if name in BOOL_OPTIONS:
                if value is not None:
                    raise CliError(f'Option "--{name}" does not take a value.', 2)
                values[name] = True
            elif value is not None:
                values[name] = value
            continue
        # kind == "value": the token after "--<name>"
        if value is _MISSING:
            raise CliError(f'Option "--{name}" requires a value.', 2)
        values[name] = value

    positionals = tuple(
        str(event[3]) for event in events if event[1] == "positional" and event is not command_event
    )
    return Invocation("run", spec, values, positionals)


def _option_rows(spec: CommandSpec) -> list[list[str]]:
    rows = []
    for name in [*spec.options, "help"]:
        if name in STRING_OPTIONS and name not in BOOL_OPTIONS:
            argument = PLACEHOLDERS.get(name, "<n>")
        else:
            argument = ""
        rows.append(
            [
                f"--{name}{' ' + argument if argument else ''}",
                spec.options.get(name, "Show this help"),
            ]
        )
    return rows


def _aligned(rows: list[list[str]]) -> list[str]:
    width = max(len(row[0]) for row in rows)
    return [f"  {row[0].ljust(width)}  {row[1]}" for row in rows]


def render_help() -> str:
    lines = [
        f"{PROGRAM_NAME} <command> [options]",
        "",
        "Reachfold free outbound tools from the terminal. No sign-up, no API key.",
        "",
        "Commands:",
        *(f"  {spec.name.ljust(9)}  {spec.summary}" for spec in COMMAND_SPECS),
        "",
        "Options:",
        *_aligned(
            [
                [
                    "--base-url <url>",
                    f"API base URL for verify, audit and score (default: {DEFAULT_BASE_URL})",
                ],
                ["--json", NETWORK_OPTIONS["json"]],
                ["--no-banner", SHARED_NO_BANNER],
                ["--help", "Show this help"],
                ["--version", "Print the CLI version"],
            ]
        ),
        "",
        f'Run "{PROGRAM_NAME} <command> --help" for the options of one command.',
        EXIT_CODES_HELP,
        "",
    ]
    return "\n".join(lines)


def render_command_help(spec: CommandSpec) -> str:
    usage = f"{PROGRAM_NAME} {spec.name}{f' {spec.usage}' if spec.usage else ''} [options]"
    lines = [
        usage,
        "",
        spec.summary,
        "",
        *(
            [
                "Arguments:",
                *(f"  {line}" for line in spec.argument_help),
                "",
            ]
            if spec.argument_help
            else []
        ),
        "Options:",
        *_aligned(_option_rows(spec)),
        "",
        *spec.description,
        "",
        EXIT_CODES_HELP,
        "",
    ]
    return "\n".join(lines)


def run_cli(
    argv: Sequence[str],
    streams: Streams,
    settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
) -> int:
    invocation = parse_command_line(argv)
    if invocation.action == "version":
        streams.stdout(f"{PROGRAM_NAME} {__version__}\n")
        return EXIT_OK
    if invocation.action == "help":
        command = invocation.command
        streams.stdout(render_help() if command is None else render_command_help(command))
        return EXIT_OK

    options = invocation.options
    command = invocation.command
    if command is None:  # excluded by parse_command_line
        raise CliError("No command selected.", 2)
    json_output = options.get("json") is True
    no_banner = options.get("no-banner") is True
    base_url = options.get("base-url") if isinstance(options.get("base-url"), str) else None
    positionals = invocation.positionals

    if command.name == "verify":
        file = options.get("file") if isinstance(options.get("file"), str) else None
        exit_code = run_verify(positionals, file, base_url, json_output, streams, settings)
    elif command.name == "audit":
        file = options.get("file") if isinstance(options.get("file"), str) else None
        exit_code = run_audit(positionals, file, base_url, json_output, streams, settings)
    elif command.name == "score":
        subject = options.get("subject") if isinstance(options.get("subject"), str) else None
        body_file = options.get("body-file") if isinstance(options.get("body-file"), str) else None
        exit_code = run_score(
            positionals, subject, body_file, base_url, json_output, streams, settings
        )
    elif command.name == "permute":
        exit_code = run_permute(
            _optional_str(options, "first"),
            _optional_str(options, "last"),
            _optional_str(options, "domain"),
            json_output,
            streams,
        )
    else:
        roi_options = {flag: _optional_str(options, flag) for flag in ROI_FLAGS}
        exit_code = run_roi(roi_options, json_output, streams)

    # One factual line after the result; --no-banner or OUTBOUND_UTILS_NO_BANNER=1 switches it off.
    if should_show_banner(no_banner, streams.env):
        streams.stderr(f"{BANNER}\n")
    return exit_code


def _optional_str(options: Mapping[str, Any], name: str) -> str | None:
    value = options.get(name)
    return value if isinstance(value, str) else None


def main(argv: Sequence[str] | None = None) -> int:
    streams = system_streams()
    args = list(sys.argv[1:]) if argv is None else list(argv)
    try:
        return run_cli(args, streams)
    except CliError as err:
        streams.stderr(f"Error: {err.message}\n")
        return err.exit_code
    except KeyboardInterrupt:
        streams.stderr("\nInterrupted.\n")
        return 130
    except Exception as err:  # the CLI never shows a stack trace
        streams.stderr(f"Unexpected error: {first_line(err)}\n")
        return EXIT_FAILURE
