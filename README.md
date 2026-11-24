# cold-email-mcp

Command-line access to the five free outbound tools at [tryreachfold.com/tools](https://tryreachfold.com/tools).
No sign-up, no API key. Two implementations with the same contract:

| Directory | Runtime | Install and run |
|---|---|---|
| [`node/`](node/) | Node.js 20+ (TypeScript, zero runtime dependencies) | `npx cold-email-mcp --help` |
| [`python/`](python/) | Python 3.10+ (stdlib only) | `uvx cold-email-mcp --help` |

## Commands

Network commands call the public REST API on tryreachfold.com. `permute` and `roi` run fully offline.

```
cold-email-mcp verify test@gmail.com --file more-leads.txt
cold-email-mcp audit openai.com acme.com
cold-email-mcp score --subject "Quick question" --body-file email.txt
cold-email-mcp permute --first Jane --last Doe --domain acme.com
cold-email-mcp roi --meetings 20 --deal-value 8000 --plan growth
```

Every command supports:

- `--json` — raw JSON on stdout, one document per line for batch commands
- `--base-url <url>` — API base URL (default `https://tryreachfold.com`; plain http only for localhost)
- `--no-banner` or env `OUTBOUND_UTILS_NO_BANNER=1` — skip the closing waitlist line
- `--help`, `--version`

Results go to stdout (machine-readable); warnings, progress and the banner go to stderr.
Exit codes: `0` success, `1` network/API error or skipped input lines, `2` invalid arguments.

Batch input: `--file <path>` reads one item per line (`-` reads stdin). Invalid lines are skipped
with a warning on stderr and the command exits `1`.

## What the tools do — and what they do not

- **verify** — syntax check, domain existence, MX records, disposable/role flags.
  **No SMTP handshake**: an existing mailbox is not confirmed, catch-all domains are not detected.
- **audit** — SPF (including the DNS-lookup limit), DKIM (a fixed list of common selectors),
  DMARC, MX, MTA-STS, domain age, score 0–100 with concrete fixes.
  **No sending-IP blacklist check, no inbox placement test.** "DKIM not found" means the selector
  is not on the checked list, not that DKIM is unset.
- **score** — deterministic word/pattern heuristic, 0–100 with triggers.
  **Not SpamAssassin** and not a prediction of Gmail/Outlook filters.
- **permute** — common corporate address patterns from a first and last name (Cyrillic is
  transliterated). The patterns are guesses, not verified addresses.
- **roi** — arithmetic on your own inputs: infrastructure estimate, funnel, and cost three ways
  (in-house SDR / lead agency / Reachfold). Estimates only, not a quote.

## Privacy

The commands send exactly what you type to `https://tryreachfold.com`: the email addresses,
domains, and the subject/body text you pass in. Nothing else is uploaded; results run of
`audit` are cached at the edge for up to 1 hour. The CLI stores nothing locally.

## Rate limits

The public tools allow about 30 requests per 10 seconds per IP. The CLI keeps batch runs at or
below 2 requests per second and retries `429`/`5xx` responses up to 3 attempts with exponential
backoff before failing with a clear message.

## Development

```sh
cd node && npm install && npm test && npm run build   # dist/ + npm pack
cd python && uv sync && uv run pytest && uv build     # dist/ wheel + sdist
```

`fixtures/` contains shared test expectations used by both packages.

## License

Apache-2.0.
