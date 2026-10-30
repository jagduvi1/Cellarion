/**
 * The developer guide (Markdown) and the per-operation code samples of the
 * public API document (openapi/document.js). Redoc renders the guide before
 * the reference on cellarion.app/developers, and routes/og.js renders the
 * same text for crawlers, so the page, the raw document and the crawler copy
 * cannot disagree.
 *
 * Everything takes the server's own base URL: a self-hosted server's
 * document shows its own address in every example.
 */

const { DEPRECATED_SINCE, SUNSET } = require('../config/apiDeprecations');

const H = (base) => `-H "Authorization: Bearer $CELLARION_TOKEN" "${base}`;
const longDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function guideMarkdown(base) {
  return `
The stable REST API for **your own Cellarion data**: your cellars and the ones shared with you, bottles, racks, personal fields, statistics and notifications. You reach it with a personal API token. This page describes the version of the server it is served from; the raw OpenAPI 3.1 document is at [/api/openapi.json](/api/openapi.json).

## Which interface should I use?

| You are building | Use |
|---|---|
| A dashboard, a home-automation integration, a script | **This REST API**, starting with \`GET /api/inventory\` |
| Something that should react when the cellar changes | The **event stream**, \`GET /api/events/stream\`, then refetch |
| An AI assistant (Claude, ChatGPT and others) | **MCP**: see [Connect an AI assistant](/connect-ai) |
| A temperature or humidity sensor | **Climate ingest**, \`POST /api/climate/ingest\` |

The API gives you your own data. It does not expose Cellarion's AI features (label scanning, enrichment, the cellar chat); those stay in the app, and nothing in this reference spends AI credits.

## Getting started

1. **Create a token.** In the app, open *Settings → API tokens* and create one with the fewest scopes you need: \`read\` for a dashboard, plus \`consume\` if your integration takes bottles out. The token is shown once; store it like a password.
2. **Pick the base URL.** \`https://cellarion.app\`, or your own server's address if you self-host. A self-hosted server can run an older version (see *Stability and versioning*).
3. **Make a first call.**

   \`\`\`bash
   export CELLARION_TOKEN=cel_…
   curl ${H(base)}/api/auth/whoami"
   curl ${H(base)}/api/inventory"
   \`\`\`

4. **Or use a ready-made client.**
   - **Python:** [pycellarion](https://pypi.org/project/pycellarion/) (\`pip install pycellarion\`), the async client behind the Home Assistant integration.
   - **Home Assistant:** [Cellarion for Home Assistant](https://github.com/jagduvi1/ha-cellarion), installable from HACS.

   \`\`\`python
   import aiohttp
   from pycellarion import CellarionClient

   async with aiohttp.ClientSession() as session:
       client = CellarionClient(session, "${base}", token="cel_…")
       result = await client.get_inventory()
       print(len(result.data["bottles"]), "bottles")
   \`\`\`

## Authentication and scopes

Send the token in the \`Authorization\` header: \`Authorization: Bearer cel_…\`. Never put it in a URL, where it ends up in logs and browser history.

| Scope | Allows |
|---|---|
| \`read\` | Reading your cellars and the ones shared with you: bottles, racks, personal fields, statistics, notifications, and the event stream |
| \`consume\` | Taking bottles out of the cellar |
| \`climate\` | Posting sensor readings. Device tokens get it when you add a climate device in the app |
| \`write\` | AI assistants over MCP only; it opens no REST operation |

A request outside the token's scopes answers \`403\`. An unknown or revoked token answers \`401\`.

## Errors

Every error is JSON: \`{"error": "A human-readable message"}\`, sometimes with a machine-readable \`code\`.

| Status | Meaning | What to do |
|---|---|---|
| \`400\` | The request is malformed | Fix the request |
| \`401\` | No token, or it is invalid or revoked | Ask the user for a new token; retrying will not help |
| \`403\` | The token lacks the scope, or the user lacks the role in that cellar | Ask for a token with the right scope |
| \`404\` | Not found, or not visible to this user | Check the id |
| \`409\` | The state moved on, e.g. the bottle already left the cellar | Refetch before trying again |
| \`429\` | Rate limited | Wait \`Retry-After\` seconds |
| \`5xx\` | Server trouble | Retry later, with backoff |

## Rate limits

Every answer carries \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\` (seconds until the window resets) and \`RateLimit-Policy\` (e.g. \`200;w=900\`: 200 requests per 900 seconds). A \`429\` also carries \`Retry-After\`. Today that is about 200 reads per 15 minutes per address, 60 writes per 15 minutes, and 60 inventory reads per 10 minutes per user. These numbers can change: read the headers rather than hard-coding them.

## Caching with ETag

\`GET /api/inventory\` answers with an \`ETag\`. Send it back as \`If-None-Match\`; when nothing changed you get \`304 Not Modified\` with no body, at almost no cost on either side. A good pattern is to poll the inventory every few minutes with \`If-None-Match\`, or to refetch when the event stream says something changed.

## Pagination

\`GET /api/bottles\` takes \`limit\` (1 to 200, default 30) and \`offset\` (default 0). The answer gives \`total\`, \`count\`, \`limit\` and \`skip\` (the offset of this page); page until \`skip + count\` reaches \`total\`. For the whole cellar at once, use \`GET /api/inventory\` instead.

## Live updates

\`GET /api/events/stream\` is a Server-Sent Events stream. It sends \`stats_changed\`, \`notification\` or \`climate\` when your data changes: it says *that* something changed, not what, so refetch what you show. A \`: hb\` comment arrives every 25 seconds; reconnect with backoff after 90 seconds of silence. Authenticate with the \`Authorization\` header (a browser \`EventSource\` cannot send headers; use a client that can).

## Revoking a token

When a user removes your integration, revoke its token with the token itself: \`DELETE /api/tokens/self\`. Users can also revoke any token under *Settings → API tokens*.

## Stability and versioning

What is in this reference is **stable**:

- A documented endpoint, parameter or field keeps its name, type and meaning.
- New endpoints, optional parameters, fields and enum values can appear at any time. Ignore what you don't know.
- A removal or breaking change is announced in the [release notes](https://github.com/jagduvi1/Cellarion/releases) and on this page, its answers carry \`Deprecation\` and \`Sunset\` headers, and it takes effect **no sooner than six months later**.
- \`GET /api/inventory\` carries a \`schema\` number that changes only with a breaking change.
- Anything a token can reach that is **not** in this reference is internal and may change without notice. Please don't build on it. If you need something that isn't here, [open an issue](https://github.com/jagduvi1/Cellarion/issues).

**Self-hosted servers** update on their owner's schedule, so they can be older than cellarion.app. Read a server's version from \`GET /api/health\`, or treat a \`404\` or \`403\` on a documented endpoint as "not supported on this server" and carry on without it.

### Being removed

Until now a \`read\` token could also reach other \`GET\` routes under \`/api/cellars\`, \`/api/bottles\`, \`/api/stats\` and \`/api/notifications\` that are not in this reference, such as \`/api/cellars/{id}\` or \`/api/stats/value-history\`. They are deprecated from ${longDate(DEPRECATED_SINCE)}: their answers carry \`Deprecation\`, \`Sunset\` and \`Link\` headers, and **from ${longDate(SUNSET)} they answer tokens with \`403\`**. \`GET /api/inventory\` covers most of what they were used for; if something you need is missing, [open an issue](https://github.com/jagduvi1/Cellarion/issues) before then. The owner of a token that still calls them is notified, reminded as the date nears, and sees which routes on the token under *Settings → API tokens*.

## Security

- Keep tokens secret: store them like passwords, never commit them, never put them in a URL.
- Ask for the fewest scopes you need.
- Revoke tokens you no longer use under *Settings → API tokens*, and revoke your integration's token when it is removed.
- Call \`https://\` addresses only, so the token never crosses the network in the clear.
- Image paths in answers point at the same server; fetch only paths of the documented shape.

## Terms of use

Build whatever helps you and others enjoy a cellar. A few ground rules keep it fair:

- **Personal and open-source use is welcome.** Use the API for yourself, or share what you build for free as open source, like the Home Assistant integration.
- **Keep it free.** Don't charge for a product or service built on the Cellarion API, or for access to Cellarion data. Have a commercial idea? Talk to us first.
- **If other people use your service,** keep it free and open source and say clearly that it isn't run by Cellarion. Never ask anyone for their Cellarion password, only for a token, which you keep safe and its owner can remove. You are responsible for the data your service receives.
- **Play nice.** Stay within the rate limits, don't copy the shared wine registry in bulk (see the [Registry Data Terms](/terms)), and don't present your project as an official Cellarion product.

We may revoke a token or block access that breaks these terms or puts users or the service at risk. These terms cover cellarion.app: the owner of a self-hosted server sets their own, and the Cellarion software stays open source under the AGPL-3.0.
`.trim();
}

const PY_CLIENT = (base, body) => `import aiohttp
from pycellarion import CellarionClient

async with aiohttp.ClientSession() as session:
    client = CellarionClient(session, "${base}", token="cel_…")
${body.split('\n').map((l) => `    ${l}`).join('\n')}`;

const PY_PLAIN = (base, path, { method = 'GET', body } = {}) => `import json, urllib.request

req = urllib.request.Request(
    "${base}${path}",
    method="${method}",
    headers={"Authorization": "Bearer cel_…"${body ? ', "Content-Type": "application/json"' : ''}},${body ? `\n    data=json.dumps(${body}).encode(),` : ''}
)
with urllib.request.urlopen(req) as res:
    answer = json.load(res)`;

const curl = (source) => ({ lang: 'Shell', label: 'curl', source });
const python = (source) => ({ lang: 'Python', label: 'Python', source });

/** operationId → x-codeSamples for one server's base URL. */
function codeSamples(base) {
  const ID = '66f0a1b2c3d4e5f6a7b8c906';
  return {
    getInventory: [
      curl(`curl -i ${H(base)}/api/inventory"\n\n# Later: send the ETag back; 304 means nothing changed\ncurl -i -H 'If-None-Match: W/"…"' ${H(base)}/api/inventory"`),
      python(PY_CLIENT(base, 'result = await client.get_inventory()\n# later, with the tag of the copy you hold:\nresult = await client.get_inventory(etag=result.etag)\nif result.not_modified:\n    pass  # your copy is current')),
    ],
    streamEvents: [
      curl(`curl -N -H "Accept: text/event-stream" ${H(base)}/api/events/stream"`),
      python(PY_CLIENT(base, 'async for event in client.events_stream():\n    if event != "_connected":\n        print("changed:", event)')),
    ],
    whoAmI: [
      curl(`curl ${H(base)}/api/auth/whoami"`),
      python(PY_CLIENT(base, 'account_id = await client.get_account_id()')),
    ],
    listCellars: [
      curl(`curl ${H(base)}/api/cellars"`),
      python(PY_CLIENT(base, 'cellars = (await client.get_cellars())["cellars"]')),
    ],
    listBottles: [
      curl(`curl ${H(base)}/api/bottles?maturity=peak&limit=10"`),
      python(PY_CLIENT(base, 'peak = await client.get_peak_bottles(limit=10)\nfor bottle in peak["bottles"]["items"]:\n    print(bottle["wineDefinition"]["name"], bottle.get("vintage"))')),
    ],
    getBottle: [
      curl(`curl ${H(base)}/api/bottles/${ID}"`),
      python(PY_PLAIN(base, `/api/bottles/${ID}`)),
    ],
    consumeBottle: [
      curl(`curl -X POST -H "Content-Type: application/json" \\\n  -d '{"reason": "drank", "rating": 4, "consumedRatingScale": "5", "ifActive": true}' \\\n  ${H(base)}/api/bottles/${ID}/consume"`),
      python(PY_CLIENT(base, `await client.consume_bottle("${ID}", reason="drank", rating=4)`)),
    ],
    listRacks: [
      curl(`curl ${H(base)}/api/racks?cellar=66f0a1b2c3d4e5f6a7b8c902&summary=1"`),
      python(PY_PLAIN(base, '/api/racks?cellar=66f0a1b2c3d4e5f6a7b8c902&summary=1')),
    ],
    getStatsOverview: [
      curl(`curl ${H(base)}/api/stats/overview"`),
      python(PY_CLIENT(base, 'stats = (await client.get_stats_overview())["stats"]\nprint(stats["overview"]["totalBottles"], "bottles")')),
    ],
    listNotifications: [
      curl(`curl ${H(base)}/api/notifications"`),
      python(PY_CLIENT(base, 'notes = await client.get_notifications()\nprint(notes["unreadCount"], "unread")')),
    ],
    getUnreadCount: [
      curl(`curl ${H(base)}/api/notifications/unread-count"`),
      python(PY_PLAIN(base, '/api/notifications/unread-count')),
    ],
    ingestClimate: [
      curl(`curl -X POST -H "Content-Type: application/json" \\\n  -d '{"readings": [{"channel": "fridge", "type": "temperature", "value": 12.4}]}' \\\n  -H "Authorization: Bearer $CELLARION_DEVICE_TOKEN" "${base}/api/climate/ingest"`),
      python(PY_PLAIN(base, '/api/climate/ingest', { method: 'POST', body: '{"readings": [{"channel": "fridge", "type": "temperature", "value": 12.4}]}' })),
    ],
    revokeOwnToken: [
      curl(`curl -X DELETE ${H(base)}/api/tokens/self"`),
      python(PY_CLIENT(base, 'revoked = await client.revoke_own_token()')),
    ],
    getHealth: [
      curl(`curl "${base}/api/health"`),
      python(PY_CLIENT(base, 'health = await client.get_health()\nprint(health["version"])')),
    ],
    getThumbnail: [
      curl(`curl -o label.webp "${base}/api/uploads/thumbs/processed/3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b.webp.webp"`),
      python(PY_CLIENT(base, 'body, content_type = await client.get_image(bottle["image"])  # a path from the inventory')),
    ],
    getOpenApiDocument: [
      curl(`curl -o cellarion-openapi.json "${base}/api/openapi.json"`),
      python(`import json, urllib.request\n\nwith urllib.request.urlopen("${base}/api/openapi.json") as res:\n    document = json.load(res)`),
    ],
  };
}

module.exports = { guideMarkdown, codeSamples };
