# cold-email-mcp

**Give any AI agent — or your terminal — the cold-email checks that decide whether a campaign is heard at all.** An MCP server (hosted and local stdio) plus a CLI, free, no signup. An MCP server (hosted and local stdio) plus a CLI, free, no signup.

Most cold campaigns fail before a single line of copy is written: an SPF record over its DNS-lookup limit, a two-week-old domain, a draft full of filter bait, an address that never existed. This project puts those checks where you already work — Claude, Cursor, or any Model Context Protocol client — and in plain `npx` / `uvx` one-liners.

Free, no signup, no API key. Built by [Reachfold](https://tryreachfold.com), a cold outreach platform in pre-launch; the hosted tools have been running at [tryreachfold.com/tools](https://tryreachfold.com/tools) since day one.

## Connect — three ways

**1. Hosted MCP server (remote, zero setup)** — for Claude Code, Cursor, and any MCP client:

```sh
claude mcp add --transport http cold-email-mcp https://tryreachfold.com/api/mcp
```

Remote Streamable HTTP, stateless, no authentication. The agent gets five tools and can audit a prospect's domain, sanity-check a draft, or run outreach math inside the conversation.

**2. Local MCP server (stdio, in this repo)** — for Claude Desktop and clients that prefer a local process:

```sh
cd mcp && npm install && npm run build
```

Then point your client at the built server, e.g. in `claude_desktop_config.json`:

```json
{ "mcpServers": { "cold-email-mcp": { "command": "node", "args": ["/absolute/path/to/cold-email-mcp/mcp/dist/server.js"] } } }
```

Same five tools (`audit_domain`, `verify_email`, `score_email`, `generate_email_permutations`, `calculate_outbound_roi`); network tools call the public API, permutations and ROI run fully offline. Implementation: [`mcp/`](mcp/) on the MCP TypeScript SDK v2.

**3. CLI (same five checks in a pipeline):**

```sh
npx cold-email-mcp audit openai.com        # Node.js 20+
uvx cold-email-mcp verify jane@acme.com    # Python 3.10+
```

CLI implementations: [`node/`](node/) (TypeScript, zero runtime dependencies) and [`python/`](python/) (stdlib only), parity-tested against the web tools.

## What your agent can do with it

| Tool | Use it when |
|---|---|
| `audit_domain` | You're about to send from a domain. SPF with its DNS-lookup count against the limit of 10, DKIM on known selectors, DMARC, MTA-STS, MX, domain age via RDAP — a 0-100 score with fixes in plain outreach language, not DNS jargon. |
| `verify_email` | An address looks right but you don't trust it. Syntax, domain existence, MX, disposable and role flags — the cheap layer that kills dead domains before they bounce. |
| `score_email` | A draft reads fine to you. Deterministic word/pattern heuristic, 0-100 with every trigger and its fix. |
| `generate_email_permutations` | You know the name, not the format. The 12 common corporate patterns for a name and domain, Cyrillic transliterated. |
| `calculate_outbound_roi` | You have a meetings target. Required email volume, domains/inboxes at safe limits, and what a meeting really costs three ways: in-house SDR, agency, or Reachfold. |

`permute` and `roi` run fully offline; the other three read live DNS through the public API at tryreachfold.com.

**The honest part — read before you rely on it:**

- Verification is DNS-level. No SMTP handshake: a mailbox isn't confirmed, catch-all domains stay invisible.
- The audit doesn't check IP blocklists and doesn't predict inbox placement. "DKIM not found" means the selector wasn't on the checked list, not that DKIM is unset.
- The spam score is a deterministic heuristic — not SpamAssassin, not a Gmail forecast.
- Permutations are guesses. The ROI math is arithmetic on your numbers, not a quote.

## CLI reference

```sh
cold-email-mcp verify test@gmail.com --file more-leads.txt
cold-email-mcp audit openai.com acme.com
cold-email-mcp score --subject "Quick question" --body-file email.txt
cold-email-mcp permute --first Jane --last Doe --domain acme.com
cold-email-mcp roi --meetings 20 --deal-value 8000 --plan growth
```

Every command supports `--json` (raw JSON on stdout), `--base-url <url>` (default `https://tryreachfold.com`), `--no-banner`, `--help`, `--version`. Results go to stdout; progress and warnings go to stderr. Exit codes: `0` success, `1` network/API error or skipped lines, `2` invalid arguments. `--file <path>` reads one item per line (`-` is stdin); invalid lines are skipped with a warning.

## Privacy & limits

The tools send exactly what you type — email addresses, domains, draft text — to tryreachfold.com and nothing else; audit results are cached at the edge for up to 1 hour, nothing is stored locally or server-side beyond that cache. Public rate limit is 30 requests per 10 seconds per IP; the CLI paces batches to 2 requests/second and retries `429`/`5xx` with backoff.

## Development

```sh
cd node && npm install && npm test && npm run build   # dist/ + npm pack
cd python && uv sync && uv run pytest && uv build     # dist/ wheel + sdist
```

`fixtures/` holds the shared expectations both packages are tested against.

## License

Apache-2.0. The hosted web tools: [tryreachfold.com/tools](https://tryreachfold.com/tools).
