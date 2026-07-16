# MCP OAuth 2.1 — connector authorization server

Lets **claude.ai / ChatGPT / Claude Desktop** connect to Cellarion's MCP
endpoint with one click ("Add connector → paste `https://cellarion.app/api/mcp`
→ approve"), instead of a user pasting a `cel_` token. Cellarion acts as both
the OAuth **resource server** (`/api/mcp`) and the **authorization server**.

Standards: OAuth 2.1 + PKCE (RFC 7636, S256 only) + Dynamic Client Registration
(RFC 7591) + AS metadata (RFC 8414) + protected-resource metadata (RFC 9728) +
resource indicators (RFC 8707). MCP Authorization spec (2025-06-18).

## How it fits the existing token model

An OAuth access token **is a scoped, expiring `cel_` `ApiToken`** (`origin:
'oauth'`). So it flows through the exact same auth path as a user-minted PAT —
the `SCOPE_ALLOWLIST` confines it to `/api/mcp`, the per-tool registry filter
decides which tools it sees, instant revoke works, and it appears in the user's
connected-tokens list. The only additions are `expiresAt` (1h access token) +
`refreshTokenHash` (rotated every refresh) + `oauthClientId` + `resource`.
Nothing about the REST surface changes.

## Endpoints

| Path | What |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata (**at origin root**) |
| `GET /.well-known/oauth-protected-resource/api/mcp` | RFC 9728 PRM (**at origin root**) |
| `POST /api/mcp/oauth/register` | Dynamic Client Registration |
| `GET  /api/mcp/oauth/authorize` | validates request → 302 to the consent page |
| `POST /api/mcp/oauth/approve` | the logged-in user's consent → mints a code (JWT-only) |
| `POST /api/mcp/oauth/token` | code exchange + refresh rotation |
| `POST /api/mcp/oauth/revoke` | RFC 7009 revocation |
| `/connect-ai/authorize` (frontend) | the consent screen |

The flow: client hits `/api/mcp` with no token → **401 + `WWW-Authenticate:
Bearer resource_metadata="…"`** → client fetches PRM → AS metadata → registers
(DCR) → opens `/authorize` in the user's browser → backend 302s to
`/connect-ai/authorize` → user logs in (inline) + approves → `/approve` mints a
single-use code → client exchanges it at `/token` with its PKCE verifier → gets
a `cel_` access token + refresh token → uses the access token on `/api/mcp`.

## ⚠️ PROD deployment steps (only Johan can do these)

Deploying the image with nothing configured is a **safe no-op** — the endpoints
exist but nobody reaches the two root `.well-known` paths until nginx is told to
proxy them. Do the nginx change, then it's live. No new env vars, containers,
ports, or migrations.

### 1. nginx (the one required change) — `docker-compose.prod.yml` frontend

The frontend nginx serves the SPA at `/` and proxies `/api` to the backend. The
two OAuth discovery documents live at the **origin root** (spec-mandated), so
nginx must proxy them to the backend too — otherwise they fall through to the
SPA `index.html` and every connect attempt fails discovery. Add, alongside the
existing `/api` proxy block:

```nginx
# MCP OAuth discovery — must reach the backend, not the SPA.
location /.well-known/oauth-authorization-server {
    proxy_pass http://backend:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /.well-known/oauth-protected-resource {
    proxy_pass http://backend:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

(The `/authorize`, `/token`, `/register`, `/revoke` endpoints are under
`/api/mcp/oauth/*` and are already covered by the existing `/api` proxy — no
extra rule needed. `/connect-ai/authorize` is a normal SPA route.)

Everything else is already in place: prod `FRONTEND_URL=https://cellarion.app`
(the issuer + all endpoint URLs derive from it), TLS via Traefik (all endpoints
+ redirect URIs are HTTPS), and the backend is fronted at the same origin.

### 2. Verify after deploy

```bash
curl -s https://cellarion.app/.well-known/oauth-authorization-server | jq .issuer
# → "https://cellarion.app"
curl -s https://cellarion.app/.well-known/oauth-protected-resource/api/mcp | jq .resource
# → "https://cellarion.app/api/mcp"
curl -si -X POST https://cellarion.app/api/mcp | grep -i www-authenticate
# → WWW-Authenticate: Bearer resource_metadata="https://cellarion.app/.well-known/oauth-protected-resource/api/mcp"
```

Then add the connector in Claude/ChatGPT with URL `https://cellarion.app/api/mcp`
and confirm the consent screen appears and a tool call works.

### 3. WAF / egress note

If a WAF (Cloudflare, etc.) fronts `cellarion.app`, Anthropic's connector calls
come from `160.79.104.0/21` and must reach both the discovery docs and the
token/authorize endpoints. Discovery is unauthenticated GET — don't let a bot
rule block it.

## Security model (six things worth knowing)

1. **PKCE S256 is mandatory** — `plain` is never advertised or accepted;
   verifier checked in constant time against the stored challenge.
2. **redirect_uri is exact-matched** against the DCR-registered set, validated
   *before* any redirect (no open-redirect / code leak). https or loopback only.
3. **Codes are single-use** (atomic `consumedAt` claim) and 5-minute-lived, and
   bound to one client + redirect_uri + user + scopes + resource.
4. **Refresh tokens rotate** on every use (OAuth 2.1 §4.3.1) — the old access
   *and* refresh token die immediately. A replayed refresh token is
   `invalid_grant`.
5. **Consent is a logged-in user's decision** — `/approve` is JWT-only,
   re-validates the whole request server-side, and demo accounts are blocked.
6. **Everything is revocable + bounded** — instant revoke (per token, or the
   user deletes it in Settings), a per-account cap of 20 live AI connections,
   and the tokens are covered by GDPR export + account-deletion erasure.

## Rollback

Remove the two nginx `location` blocks and reload nginx — discovery stops
resolving, so no new connections can be established. Existing connections keep
working until their tokens are revoked (or revoke them in bulk by deleting the
`OAuthClient` rows / the `origin:'oauth'` `ApiToken`s).
