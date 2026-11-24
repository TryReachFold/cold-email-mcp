"""JSON over HTTP with stdlib only: throttling, retries and honest error messages."""

from __future__ import annotations

import http.client
import json
import socket
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit

from . import __version__
from .base import PROGRAM_NAME, ApiError, CliError, Streams, as_object, one_line, truncate
from .inputs import normalize_base_url


@dataclass(frozen=True)
class HttpSettings:
    timeout_s: float = 30.0
    # Minimum gap between two request starts: 0.5 s keeps the client at or below 2 requests/s
    # (the site allows 30 requests per 10 seconds per IP).
    min_interval_s: float = 0.5
    # Waits before the 2nd and 3rd attempt.
    retry_delays_s: tuple[float, ...] = (1.0, 2.0)
    # A longer Retry-After is a spent quota, not a hiccup: fail instead of waiting.
    max_retry_after_s: float = 30.0
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.monotonic


DEFAULT_HTTP_SETTINGS = HttpSettings()


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: str
    retry_after: str | None = None


def _is_retryable(status: int) -> bool:
    return status == 429 or status >= 500


def is_success(status: int) -> bool:
    return 200 <= status < 300


def parse_retry_after(header: str | None) -> float | None:
    """Retry-After header as a delay in seconds; seconds or an HTTP-date."""
    text = (header or "").strip()
    if text.isdigit():
        return float(text)
    if not text:
        return None
    try:
        at = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return max(0.0, (at - datetime.now(timezone.utc)).total_seconds())


def describe_network_error(exc: BaseException, host: str, timeout_s: float) -> str:
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, TimeoutError):
        return f"Request to {host} timed out after {round(timeout_s)}s. Try again later."
    if isinstance(reason, socket.gaierror):
        return f"Could not resolve {host}. Check the URL and your connection."
    if isinstance(reason, ConnectionRefusedError):
        return f"Connection refused by {host}. Is the server running?"
    code = getattr(reason, "errno", None)
    suffix = f" ({code})" if code else ""
    return f"Could not reach {host}. Check your connection and try again.{suffix}"


class HttpClient:
    """Sequential JSON POSTs with throttling and retries (429 and 5xx, at most 3 attempts)."""

    def __init__(
        self,
        settings: HttpSettings,
        base_url: str,
        host: str,
        on_retry: Callable[[str], None],
    ) -> None:
        self._settings = settings
        self._base_url = base_url
        self.host = host
        self._on_retry = on_retry
        self._next_slot_at = 0.0
        self._opener = urllib.request.build_opener()

    def post(self, path: str, payload: object) -> HttpResult:
        retry_delays = self._settings.retry_delays_s
        attempts = len(retry_delays) + 1
        attempt = 0
        while True:
            attempt += 1
            self._wait_for_slot()
            result = self._send(path, payload)
            if attempt >= attempts or not _is_retryable(result.status):
                return result
            retry_after_s = parse_retry_after(result.retry_after)
            if retry_after_s is not None and retry_after_s > self._settings.max_retry_after_s:
                return result
            delay_s = max(retry_delays[attempt - 1], retry_after_s or 0.0)
            self._on_retry(
                f"Got HTTP {result.status} from {self.host}, retrying in {round(delay_s)}s "
                f"(attempt {attempt + 1} of {attempts})..."
            )
            self._settings.sleep(delay_s)

    def _wait_for_slot(self) -> None:
        """Never lets two requests start less than min_interval_s apart."""
        settings = self._settings
        remaining = self._next_slot_at - settings.now()
        while remaining > 0:
            settings.sleep(remaining)
            remaining = self._next_slot_at - settings.now()
        self._next_slot_at = max(self._next_slot_at, settings.now()) + settings.min_interval_s

    def _send(self, path: str, payload: object) -> HttpResult:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": f"{PROGRAM_NAME}/{__version__} (python)",
            },
        )
        try:
            # The base URL is validated by normalize_base_url (https, or http on localhost only).
            with self._opener.open(request, timeout=self._settings.timeout_s) as response:
                return HttpResult(
                    response.status,
                    response.read().decode("utf-8", "replace"),
                    response.headers.get("Retry-After"),
                )
        except urllib.error.HTTPError as exc:
            # A 4xx/5xx is an answer, not a failure of the transport: hand it to the caller.
            with exc:
                body = exc.read().decode("utf-8", "replace")
            return HttpResult(exc.code, body, exc.headers.get("Retry-After"))
        except (OSError, http.client.HTTPException) as exc:
            raise CliError(
                describe_network_error(exc, self.host, self._settings.timeout_s)
            ) from None


@dataclass(frozen=True)
class ApiContext:
    client: HttpClient
    host: str
    json_output: bool
    streams: Streams


def create_api_context(
    base_url: str | None,
    json_output: bool,
    streams: Streams,
    settings: HttpSettings = DEFAULT_HTTP_SETTINGS,
) -> ApiContext:
    origin = normalize_base_url(base_url)
    host = urlsplit(origin).netloc
    client = HttpClient(settings, origin, host, lambda notice: streams.stderr(f"{notice}\n"))
    return ApiContext(client, host, json_output, streams)


def _failure_of(result: HttpResult) -> tuple[int, str | None, str | None]:
    """The API's ``{ error, message }`` envelope, when the server sent one."""
    try:
        envelope = as_object(json.loads(result.body))
    except ValueError:
        envelope = None
    message = envelope.get("message") if envelope else None
    code = envelope.get("error") if envelope else None
    return (
        result.status,
        one_line(message) if isinstance(message, str) and one_line(message) else None,
        code if isinstance(code, str) else None,
    )


def describe_failure(result: HttpResult, host: str) -> str:
    """One honest sentence per failure, in the wording of the site."""
    status, message, code = _failure_of(result)
    where = f"HTTP {status} from {host}"
    server = f" {message}" if message else ""
    if status == 429:
        return f"Too many requests — wait a few seconds and retry. ({where}){server}"
    if status >= 500:
        return (
            f"The tool service returned an error ({where}). Please try again in a moment.{server}"
        )
    if message:
        return f"{message} ({where}{f', {code}' if code else ''})"
    snippet = truncate(one_line(result.body), 120)
    return f"Request failed ({where}).{f' {snippet}' if snippet else ''}"


def parse_success(result: HttpResult, host: str) -> Any:
    try:
        return json.loads(result.body)
    except ValueError:
        raise ApiError(
            f"Unexpected response from {host}: not valid JSON. ({result.status})", result.status
        ) from None


# Statuses that are about one item; every other failure aborts the batch.
def _is_item_error(status: int) -> bool:
    return status in (400, 422)


@dataclass(frozen=True)
class BatchEvent:
    item: str
    raw: str = ""
    data: Any = None
    error: ApiError | None = None


def request_each(
    ctx: ApiContext,
    endpoint: str,
    items: Sequence[str],
    payload_for: Callable[[str], dict[str, Any]],
    verb: str,
) -> Iterator[BatchEvent]:
    """One request per item, in order. Raises ApiError when a failure aborts the whole batch."""
    for index, item in enumerate(items):
        if len(items) > 1:
            ctx.streams.stderr(f"{verb} {index + 1}/{len(items)}: {item}\n")
        result = ctx.client.post(endpoint, payload_for(item))
        if _is_item_error(result.status):
            yield BatchEvent(
                item, error=ApiError(describe_failure(result, ctx.host), result.status)
            )
            continue
        if not is_success(result.status):
            raise ApiError(describe_failure(result, ctx.host), result.status)
        yield BatchEvent(item, raw=result.body.strip(), data=parse_success(result, ctx.host))
