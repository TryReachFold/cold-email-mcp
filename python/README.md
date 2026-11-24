# cold-email-mcp (Python)

CLI for the free outbound tools at [tryreachfold.com/tools](https://tryreachfold.com/tools).
Standard library only — no runtime dependencies. Python 3.10+.

```sh
uvx cold-email-mcp --help              # after publish
uv run cold-email-mcp --help           # from a checkout
```

## Commands

```
cold-email-mcp verify test@gmail.com --file more-leads.txt
cold-email-mcp audit openai.com acme.com
cold-email-mcp score --subject "Quick question" --body-file email.txt
cold-email-mcp score email.txt              # file: subject, blank line, body
cold-email-mcp permute --first Jane --last Doe --domain acme.com [--json]
cold-email-mcp roi --meetings 20 --deal-value 8000 --plan growth [--json]
```

Global options: `--base-url <url>` (default `https://tryreachfold.com`), `--json`, `--no-banner`
(env `OUTBOUND_UTILS_NO_BANNER=1`), `--help`, `--version`.
Results on stdout; warnings, progress and the banner on stderr.
Exit codes: `0` success, `1` network/API error or skipped input lines, `2` invalid arguments.

Honest limitations: `verify` has no SMTP handshake (existing mailboxes are not confirmed,
catch-all domains are not detected); `audit` reads DNS only (no sending-IP blacklists, no
inbox placement); `score` is a deterministic heuristic, not SpamAssassin; `permute` patterns
are guesses. `roi` estimates from your own inputs only.

Privacy: only the emails, domains and email text you pass are sent to tryreachfold.com;
`audit` results are cached at the edge for up to 1 hour.

Batching keeps at or below 2 requests/second and retries `429`/`5xx` up to 3 attempts.

## Development

```sh
uv sync            # venv with pytest (dev group)
uv run pytest      # unit, mock-server and subprocess tests
uvx ruff check src tests
uv build           # wheel + sdist in dist/
```
