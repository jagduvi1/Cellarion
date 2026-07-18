# Connecting an AI to Cellarion (MCP)

Cellarion ships a built-in [MCP](https://modelcontextprotocol.io) server:
any MCP-capable assistant (Claude, ChatGPT, Cursor, …) can search the
cellar, advise what to open, add/consume bottles, and organise racks — with
scoped permissions, an in-app activity trail, and one-click undo. This doc
is the operator/developer view; the in-app path for users is **Settings →
Connect your AI**.

## The three ways in

| Path | Endpoint | Auth | For |
|---|---|---|---|
| One-click connector | `POST /api/mcp` | OAuth 2.1 (see [mcp-oauth.md](mcp-oauth.md)) | claude.ai / ChatGPT custom connectors |
| Personal token | `POST /api/mcp` | `Authorization: Bearer cel_…` | stdio bridges, scripts, self-rolled agents |
| Anonymous public | `POST /api/mcp/public` | none | registry lookups, drink windows, guides — no account, no PII, strict rate limit |

Transport is stateless Streamable HTTP; a client that `initialize`s may be
granted a stateful session (`Mcp-Session-Id`) with a GET/SSE stream for
`resources/subscribe` pushes. `GET /api/mcp` without a session → 405.

## Scopes

Minted per token in Settings (OAuth consent grants map to the same scopes):

- `read` — everything read-only: search/list/get, stats, exports discovery,
  sommelier intelligence.
- `consume` — consume/open/pour/restore + `undo_last`.
- `write` — add/edit bottles, racks/cellars, bulk + arrange, wine lists,
  tasting notes, preferences/profile, account export links.
- `climate` — sensor ingest only (device tokens; not an AI scope).

Scope enforcement is **structural**: a tool outside the token's scopes is
never registered on that request's server — invisible in `tools/list`,
unknown on `tools/call`. Sommelier curation tools additionally require the
`somm`/`admin` role (re-read per request for `cel_` tokens).

## Claude Desktop / Cursor (stdio bridge)

The [`cellarion-mcp`](../cellarion-mcp/) npm package proxies stdio ⇄
Streamable HTTP. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cellarion": {
      "command": "npx",
      "args": ["-y", "cellarion-mcp"],
      "env": {
        "CELLARION_TOKEN": "cel_your_token_here",
        "CELLARION_URL": "https://cellarion.your-domain.example"
      }
    }
  }
}
```

`CELLARION_URL` defaults to `https://cellarion.app`. `--token` / `--url`
flags work too.

## Smoke test (curl)

```bash
curl -s https://your-host/api/mcp \
  -H "Authorization: Bearer $CEL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

Expect `serverInfo.name: "cellarion"` and the instructions block. The same
call unauthenticated must return **401 + `WWW-Authenticate: Bearer
resource_metadata=…`** (that header is how OAuth clients discover the
authorization server — RFC 9728).

## Operational levers

- **Kill switches** (Admin → AI Connector, or `PATCH
  /api/admin/settings/rate-limits` `{ mcp: { enabled, publicEnabled } }`):
  `enabled=0` → the whole AI surface answers 503; `publicEnabled=0` → only
  the anonymous endpoint sheds. The in-app activity timeline, revert, and
  export-link downloads stay up either way.
- **Usage view**: `GET /api/admin/mcp/usage` + the Admin → AI Connector
  page — per-day calls/errors, top tools, OAuth-vs-bearer connection
  counts.
- **Per-user revocation**: deleting a token in Settings cuts its access on
  the next request; OAuth grants revoke the same way (they are ApiToken
  rows underneath).
- **Protocol rate limits** (SuperAdmin → Settings → "AI connector (MCP)
  limits"; `{ mcp: { userMax, ipMax } }` in the same PATCH): the personal
  endpoint is limited **per user** (default 300 req / 15 min — one bucket
  across all of a user's tokens and source IPs), not per IP — hosted
  connectors (claude.ai, ChatGPT) egress from a small shared IP pool, so a
  per-IP bucket would let one chatty agent starve every other hosted user.
  A high per-IP pre-auth guard (default 5000 / 15 min) bounds
  unauthenticated flooding and credential probing.
- **Budgets**: per-request call cap (20; 10 anonymous), per-user mutation
  budget (shared with the REST write limiter), the AI daily budget for the
  few tools that spend AI (semantic search embeds), and the public
  endpoint's dedicated per-IP limiter (60 / 15 min).

## Self-hosting notes

- No compose changes: the MCP server runs in-process in the backend.
- OAuth discovery needs the `.well-known` nginx pass-through — see the
  **PROD deployment steps** in [mcp-oauth.md](mcp-oauth.md).
- The contract stability rules (what may change when, how tools retire)
  live in [mcp-versioning.md](mcp-versioning.md).
