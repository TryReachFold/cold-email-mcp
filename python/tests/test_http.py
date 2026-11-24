"""Network-layer tests against a local mock server only (never against production)."""

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cold_email_mcp.base import CliError, Streams
from cold_email_mcp.cli import run_cli
from cold_email_mcp.http import DEFAULT_HTTP_SETTINGS, HttpSettings


class FakeClock:
    """Deterministic clock: sleep only advances it, so throttle and backoff are testable."""

    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class Capture:
    """Streams that record output, mirroring main()'s error handling."""

    def __init__(self) -> None:
        self.stdout: list[str] = []
        self.stderr: list[str] = []

    def streams(self) -> Streams:
        return Streams(
            stdout=lambda text: self.stdout.append(text),
            stderr=lambda text: self.stderr.append(text),
            env={},
            read_text_file=lambda path: path and open(path, encoding="utf-8").read(),  # noqa: SIM115
        )

    def run(self, args: list[str], settings: HttpSettings | None = None) -> int:
        try:
            return run_cli(args, self.streams(), settings or self.settings())
        except CliError as err:
            self.stderr.append(f"Error: {err.message}\n")
            return err.exit_code
        except Exception as err:  # noqa: BLE001
            self.stderr.append(f"Unexpected error: {err}\n")
            return 1

    def settings(self, clock: FakeClock | None = None, **overrides) -> HttpSettings:
        clock = clock or FakeClock()
        return HttpSettings(
            timeout_s=5.0,
            sleep=clock.sleep,
            now=clock.now,
            **overrides,
        )

    @property
    def out(self) -> str:
        return "".join(self.stdout)

    @property
    def err(self) -> str:
        return "".join(self.stderr)


class ScriptedHandler(BaseHTTPRequestHandler):
    script: list[dict] = []
    requests: list[dict] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        type(self).requests.append({"path": self.path, "body": body})
        step = type(self).script.pop(0) if type(self).script else {"status": 500, "body": "{}"}
        self.send_response(step["status"])
        for key, value in step.get("headers", {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(step["body"].encode("utf-8"))

    def log_message(self, *args) -> None:  # keep test output clean
        pass


@contextmanager
def scripted_server(script: list[dict]):
    class Handler(ScriptedHandler):
        pass

    Handler.script = list(script)
    Handler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", Handler.requests
    finally:
        server.shutdown()
        server.server_close()


OK_VERIFY = {"status": 200, "body": '{"email":"a@b.com","status":"valid","reason":"ok","flags":[]}'}


def test_one_json_post_per_item_and_printed_rows():
    with scripted_server(
        [
            dict(OK_VERIFY),
            {
                "status": 200,
                "body": '{"email":"c@d.com","status":"risky","reason":"no_mx","flags":["role"]}',
            },
        ]
    ) as (url, requests):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "c@d.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 0
    assert "a@b.com" in capture.out and "valid" in capture.out
    assert "c@d.com" in capture.out and "risky" in capture.out
    assert len(requests) == 2
    assert json.loads(requests[0]["body"]) == {"email": "a@b.com"}


def test_retry_on_429_then_success():
    script = [
        {"status": 429, "body": '{"error":"rate_limited","message":"Too many requests."}'},
        dict(OK_VERIFY),
    ]
    with scripted_server(script) as (url, requests):
        clock = FakeClock()
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "--no-banner", "--base-url", url], capture.settings(clock)
        )
    assert code == 0
    assert "HTTP 429" in capture.err and "retrying in 1s" in capture.err
    assert len(requests) == 2
    assert clock.value >= 1.0


def test_gives_up_after_three_attempts_on_persistent_429():
    step = {"status": 429, "body": '{"error":"rate_limited","message":"Too many requests."}'}
    with scripted_server([step, step, step]) as (url, requests):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 1
    assert "Too many requests — wait a few seconds and retry" in capture.err
    assert capture.out == ""
    assert len(requests) == 3


def test_long_retry_after_is_not_waited_out():
    with scripted_server([{"status": 429, "body": "{}", "headers": {"Retry-After": "45"}}]) as (
        url,
        requests,
    ):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 1
    assert len(requests) == 1, "45 s Retry-After exceeds the ceiling: no retry"
    assert "retrying" not in capture.err


def test_retry_on_5xx_then_success():
    with scripted_server([{"status": 502, "body": "bad gateway"}, dict(OK_VERIFY)]) as (
        url,
        requests,
    ):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 0
    assert len(requests) == 2


def test_per_item_422_continues_the_batch_and_exits_1():
    script = [
        {
            "status": 422,
            "body": '{"error":"invalid_email","message":"Provide a valid email address."}',
        },
        {
            "status": 200,
            "body": '{"email":"ok@fine.com","status":"valid","reason":"ok","flags":[]}',
        },
    ]
    with scripted_server(script) as (url, requests):
        capture = Capture()
        code = capture.run(
            ["verify", "x@y.zz", "ok@fine.com", "--no-banner", "--base-url", url],
            capture.settings(),
        )
    assert code == 1
    assert "FAILED x@y.zz" in capture.err and "invalid_email" in capture.err
    assert "ok@fine.com" in capture.out
    assert len(requests) == 2


def test_non_json_200_is_a_clear_error():
    with scripted_server([{"status": 200, "body": "<html>oops</html>"}]) as (url, _requests):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 1
    assert "not valid JSON" in capture.err


def test_batch_throttle_of_half_a_second_between_starts():
    with scripted_server([dict(OK_VERIFY) for _ in range(4)]) as (url, requests):
        clock = FakeClock()
        capture = Capture()
        code = capture.run(
            [
                "verify",
                "a@b.com",
                "a@b.com",
                "a@b.com",
                "a@b.com",
                "--no-banner",
                "--base-url",
                url,
            ],
            capture.settings(clock),
        )
    assert code == 0
    assert len(requests) == 4
    assert clock.value >= 1.5, f"expected at least 3 x 0.5 s throttle gaps, got {clock.value}"


def test_score_posts_subject_and_body():
    with scripted_server(
        [
            {
                "status": 200,
                "body": '{"spam_score":12,"verdict":"low","triggers":[],"checked_chars":2}',
            }
        ]
    ) as (url, requests):
        capture = Capture()
        code = capture.run(
            ["score", "--subject", "Hi", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 0
    assert json.loads(requests[0]["body"]) == {"subject": "Hi", "body": ""}
    assert "Spam score: 12/100 (low)" in capture.out


def test_audit_renders_issues_and_stderr_caveats():
    body = json.dumps(
        {
            "domain": "acme.com",
            "score": 55,
            "spf": None,
            "spf_lookups": 0,
            "spf_limit_exceeded": False,
            "dkim": [],
            "dmarc": None,
            "mta_sts": None,
            "mx_count": 0,
            "null_mx": False,
            "domain_age_days": None,
            "issues": [
                {"id": "spf_missing", "severity": "critical", "fix": "Publish an SPF record."},
                {"id": "dmarc_missing", "severity": "critical", "fix": "Publish a DMARC record."},
            ],
            "not_checked": ["IP blacklists"],
            "notes": ["heuristic selectors"],
        }
    )
    with scripted_server([{"status": 200, "body": body}]) as (url, _requests):
        capture = Capture()
        code = capture.run(
            ["audit", "acme.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 0
    assert "acme.com: score 55/100" in capture.out
    assert "[critical] spf_missing" in capture.out
    assert "No sending-IP blacklist" not in capture.out  # caveats live on stderr
    assert "Not checked by this tool: IP blacklists" in capture.err


def test_verify_failure_aborts_with_the_429_wording():
    step = {"status": 429, "body": '{"error":"rate_limited","message":"Too many requests."}'}
    with scripted_server([step, step, step]) as (url, requests):
        capture = Capture()
        code = capture.run(
            ["verify", "a@b.com", "c@d.com", "--no-banner", "--base-url", url], capture.settings()
        )
    assert code == 1
    assert "Too many requests" in capture.err
    assert capture.out == ""
    assert len(requests) == 3  # full retry budget spent


def test_unreachable_host_is_a_one_line_error():
    capture = Capture()
    code = capture.run(
        ["verify", "a@b.com", "--no-banner", "--base-url", "https://no-such-host.invalid"],
        HttpSettings(timeout_s=2.0),
    )
    assert code == 1
    assert "Could not resolve" in capture.err or "Could not reach" in capture.err
    assert "\n    at " not in capture.err, "no stack trace"


def test_timeout_is_reported_without_a_stack_trace(monkeypatch):
    import urllib.request

    class TimeoutOpener:
        def open(self, request, timeout=None):  # noqa: ANN001, ARG002
            raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "build_opener", lambda: TimeoutOpener())
    capture = Capture()
    code = capture.run(
        ["verify", "a@b.com", "--no-banner", "--base-url", "https://slow.example"],
        HttpSettings(timeout_s=2.0),
    )
    assert code == 1
    assert "timed out" in capture.err


def test_default_settings_shape():
    assert DEFAULT_HTTP_SETTINGS.retry_delays_s == (1.0, 2.0)
    assert DEFAULT_HTTP_SETTINGS.min_interval_s == 0.5
    capture = Capture()
    code = capture.run(["verify"])
    assert code == 2
    assert "Provide at least one email" in capture.err
