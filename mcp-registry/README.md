# MCP Registry entries

Cellarion publishes **two** servers to the official MCP registry
(`registry.modelcontextprotocol.io`), because they are two different products:

| Entry | Name | Endpoint | Who it is for |
|---|---|---|---|
| [`cellarion/`](cellarion/server.json) | `app.cellarion/cellarion` | `POST /api/mcp` | Account holders. OAuth 2.1, ~57 tools, read/consume/write scopes. |
| [`wine-registry/`](wine-registry/server.json) | `app.cellarion/wine-registry` | `POST /api/mcp/public` | Anyone. No auth, 7 read-only tools over the shared wine registry and guides. |

They are deliberately **not** two `remotes` on one entry: a client that picked a
remote at random would land on 7 tools instead of 57 and conclude the server was
broken.

The registry is not consumed directly by most host apps — its value is that the
directories and aggregators poll it, so publishing here beats submitting to each
one by hand.

---

## Prerequisites (one-time)

### 1. Namespace ownership — DNS, not HTTP

The `app.cellarion/*` namespace is claimed by proving control of
`cellarion.app`. **Use DNS verification.** HTTP verification would fetch
`https://cellarion.app/.well-known/mcp-registry-auth`, which today returns the
SPA HTML shell with a `200` (verified 2026-07-18) — a status-only check would
"succeed" while content parsing fails, which produces confusing errors. DNS also
grants subdomain namespaces; HTTP does not.

Generate the keypair (keep the private key safe — it is the long-lived
credential for the whole namespace, so store it in the password manager, not the
repo):

```bash
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
PUBLIC_KEY="$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "cellarion.app. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

Add that TXT record at the **apex** (`cellarion.app`), *not* under a selector —
`_mcp-auth` / `_mcp-registry` are common enough mistakes that the registry keeps
a list of them purely to emit a better error message.

The apex currently holds two TXT records (an SPF record and a
`google-site-verification`); adding a third is safe and does not disturb them.

### 2. `mcp-publisher`

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
```

---

## Publishing

Log in once per session. The seed is the last 32 bytes of the DER private key —
extracting it that way is exact, unlike scraping `openssl pkey -text` output,
which depends on the key happening to print across three lines and fails
silently (a truncated key, then an opaque login error) if that ever changes:

```bash
PRIVATE_KEY="$(openssl pkey -in mcp-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64)"
[ ${#PRIVATE_KEY} -eq 64 ] || { echo "seed is ${#PRIVATE_KEY} hex chars, expected 64 — aborting"; exit 1; }
mcp-publisher login dns --domain cellarion.app --private-key "${PRIVATE_KEY}"
```

Then publish from **inside each entry's directory** (`mcp-publisher` reads
`server.json` from the working directory):

```bash
cd mcp-registry/wine-registry && mcp-publisher validate && mcp-publisher publish
cd ../cellarion        && mcp-publisher validate && mcp-publisher publish
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=app.cellarion"
```

### Order matters for the `cellarion` entry

`cellarion/server.json` declares an npm package, and the registry's **only**
proof of npm ownership is that `package.json` carries an `mcpName` field
matching `server.json`'s `name`. So:

1. Publish `cellarion-mcp@0.1.1` to npm **first** (it now has
   `"mcpName": "app.cellarion/cellarion"`). This must be run in an
   **interactive terminal** — the npm account's 2FA is a passkey, so a non-TTY
   `npm publish` fails with `EOTP`.
2. Then publish `cellarion/server.json`.

Publishing it before the npm release fails with
`NPM package 'cellarion-mcp' is missing required 'mcpName' field`.

`wine-registry/server.json` has no package block and no such dependency — it can
be published immediately.

---

## Maintenance

- **Versions are immutable.** A published version cannot be edited; publish a new
  one. A listing can be withdrawn with `mcp-publisher status --status deleted`,
  but metadata is never permanently erased — so pick the name deliberately.
- **`version` tracks the app version.** Bump both `server.json` files on releases
  that change the tool surface, and re-publish.
- Both files validate against the pinned `2025-12-11` schema. Re-validate after
  any edit: `mcp-publisher validate`.
- `description` is capped at **100 characters** by the schema. The npm
  `description` field is longer and separate — do not copy one into the other.

## Before you publish

A registry listing is a discovery multiplier aimed straight at the rate limiters.
See `MCP_DISTRIBUTION_PLAN_2026-07-18.md` §4.2, §4.3 and §7 — in particular
`TRUST_PROXY_HOPS=2` must be set in the prod environment first, or every per-IP
bucket collapses into a single shared one.

## After deploying the /connect-ai page

IndexNow submission is wired to *content* routes only (blog posts, wines,
discussions) — static routes have no trigger, so the new page is not pushed to
Bing/Yandex automatically. Fire it once by hand after the deploy, the same way
blog posts are pinged:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://api.indexnow.org/indexnow?url=https://cellarion.app/connect-ai&key=<INDEXNOW_KEY>"
```

Then confirm the crawler render is live (it should return the endpoints as
literal text, not the SPA shell):

```bash
curl -s -A "ClaudeBot/1.0" https://cellarion.app/connect-ai | grep -c "api/mcp"
```
