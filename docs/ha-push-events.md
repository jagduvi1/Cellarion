# Home Assistant integration — backend asks (push events + consume support)

**Status:** shipped (§1–§4). The public, stable contract for these endpoints is the OpenAPI document at `/api/openapi.json`, rendered at https://cellarion.app/developers (source: `backend/src/openapi/document.js`). This doc keeps the design notes behind it.
**Client:** [ha-cellarion](https://github.com/jagduvi1/ha-cellarion) v1.2.0+ (client side already shipped for both, auto-detects server support)
**Author:** requested by Johan, drafted 2026-07-10

This doc covers four things the HA integration needs from the backend:

1. **Push events (SSE)** — new endpoint, spec below.
2. **Consume from HA** — no new endpoint (HA already calls the existing
   `POST /api/bottles/:id/consume`), but the urgency ladder needs to
   expose bottle ids. See [§2 Consume support](#2-consume-support).
3. **API tokens** — scoped long-lived tokens so users stop storing their
   account password in HA. See [§3 API tokens](#3-api-tokens-scoped).
   Biggest win of the three: kills the bcrypt-per-poll cost *and* the
   password-in-HA-config risk in one move.
4. **Inventory** — one read of every bottle with where it is, for the
   card's search and "find and take out". See [§4 Inventory](#4-inventory).

# 1. Push events (SSE)

## Why

The HA integration currently polls 4 REST endpoints every 30 minutes per
household, and because access tokens live 15 minutes, **every poll costs a
bcrypt login (~250 ms CPU at cost 12)** — that's the single most expensive
thing an idle integration does to the server.

With a push channel, the integration relaxes polling to a 6-hour safety
net and gets updates the moment they happen. The connection is opened
**outbound from HA to us**, so users never expose their HA instance to the
internet. Net effect per household: ~48 bcrypt logins/day → ~4, plus one
idle socket (~10–30 KB RAM, zero CPU between events).

SSE (not WebSocket) because the channel is strictly server→client, it's
plain HTTP through every proxy, and the client is 30 lines of aiohttp.

## Endpoint contract

```
GET /api/events/stream
Authorization: Bearer cel_…             (a read-scope API token; a session JWT also works)
Accept: text/event-stream
```

Responses:

| Status | Meaning |
|--------|---------|
| 200 + `text/event-stream` | stream opens |
| 401 | invalid/expired token (client re-logins once, then retries) |
| 404 / 405 / 501 or non-SSE content type | client concludes "no push support" and falls back to polling, retrying every 6 h |

That last row means **this feature can ship whenever it's ready** — old
servers and new clients coexist fine, and vice versa.

### Stream format

```
retry: 5000

event: ready
data: {}

: hb                          ← comment heartbeat, EVERY 25 SECONDS

event: stats_changed
data: {"reason":"bottle_added"}

event: notification
data: {"id":"...","type":"drink_window"}
```

- **Heartbeat every 25 s is mandatory.** The client treats >90 s of
  silence as a dead connection and reconnects; nginx's
  `proxy_read_timeout 120s` would otherwise kill idle streams too.
- Event names/payloads are informational only — the HA client treats
  *any* event as "refresh via REST". New event types can be added freely
  without breaking old clients.

### Event types and where to emit them

One emitter call per user-visible data change. Initial set:

| Event | Emit from |
|-------|-----------|
| `stats_changed` | bottle create / update / delete / consume (`routes/bottles.js`), cellar create / update / delete (`routes/cellars.js`), import completion (`services/cellarImport.js`) |
| `notification` | notification creation (incl. `drinkWindowNotifier`) |

**Debounce per user, ~2 s** (a 50-bottle import must produce one event,
not 50). The HA side also debounces its refresh (10 s), so exact tuning
is not critical.

## Auth & lifetime rules

- Validate the credential (API token or JWT) **at connect** with the existing `requireAuth` logic.
- **Do NOT terminate the stream when the access token expires.** Killing
  it at 15 min forces a fresh bcrypt login every 15 min per household —
  worse than the polling we're replacing. The stream carries no data,
  only "something changed" nudges, so a long-lived connection is an
  acceptable trade.
- Instead: cap stream lifetime at **24 h** (client reconnects), and
  **force-close all of a user's streams** on password change,
  logout-all, account lock, and account deletion (hook into the same
  places that invalidate refresh tokens).
- Cap concurrent streams **per user** (suggest 5) — a household with a
  flaky proxy shouldn't accumulate zombie connections. Reject over-cap
  with 429; the client backs off.

## Implementation sketch

A tiny in-memory bus (single process; if we ever go multi-instance this
moves to Redis pub/sub — the route stays the same):

```js
// services/eventBus.js
const streams = new Map(); // userId -> Set<res>
const timers = new Map();  // userId -> debounce timer

function emit(userId, event, data = {}) {
  const set = streams.get(String(userId));
  if (!set || set.size === 0) return;
  clearTimeout(timers.get(String(userId)));
  timers.set(String(userId), setTimeout(() => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(frame);
  }, 2000));
}

function register(userId, res) {
  const key = String(userId);
  if (!streams.has(key)) streams.set(key, new Set());
  const set = streams.get(key);
  if (set.size >= 5) return false;
  set.add(res);
  return true;
}

function unregister(userId, res) { streams.get(String(userId))?.delete(res); }
function dropUser(userId) {       // call on password change / logout-all
  for (const res of streams.get(String(userId)) ?? []) res.end();
  streams.delete(String(userId));
}

module.exports = { emit, register, unregister, dropUser };
```

```js
// routes/events.js
router.get('/stream', requireAuth, (req, res) => {
  if (!eventBus.register(req.user.id, res)) {
    return res.status(429).json({ error: 'Too many event streams' });
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',   // no-transform: keeps compression() away
    'X-Accel-Buffering': 'no',                   // nginx: do not buffer this response
  });
  res.flushHeaders();
  res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');

  const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
  const maxAge = setTimeout(() => res.end(), 24 * 3600 * 1000);
  req.on('close', () => {
    clearInterval(hb); clearTimeout(maxAge);
    eventBus.unregister(req.user.id, res);
  });
});
```

Mount as `app.use('/api/events', eventsRoute)`.

### Infra gotchas (both verified present in our stack)

1. **`compression()` is global in `app.js`** — it buffers responses.
   `Cache-Control: no-transform` (above) makes the compression module
   skip the response. Verify with curl (below); if frames don't arrive
   immediately, exclude the route explicitly.
2. **nginx proxies `/api/` with buffering on** — the per-response
   `X-Accel-Buffering: no` header disables it for this route only. No
   nginx.conf change needed; `proxy_read_timeout 120s` is fine given the
   25 s heartbeat.
3. **Rate limiters** (`apiLimiter`) count this as one request — fine.
   Make sure no future body-parser/timeout middleware assumes responses
   finish quickly.

## Acceptance test

```bash
TOKEN=$(curl -s -X POST https://cellarion.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"you@example.com","password":"..."}' | jq -r .token)

curl -N https://cellarion.app/api/events/stream -H "Authorization: Bearer $TOKEN"
# Expect: "event: ready" immediately, ": hb" every 25s.
# In another terminal, add a bottle → "event: stats_changed" within ~2s.
```

End-to-end with HA: the ha-cellarion test environment
(`ha-cellarion/dev/docker-compose.yml`) is on the same Docker network;
add a bottle via the API and the HA sensor should update within seconds
(debug log: `custom_components.cellarion.push`).

# 2. Consume support

The HA integration now exposes a `cellarion.consume_bottle` service and a
one-tap (with confirmation) consume button on its dashboard card. It uses
the **existing** `POST /api/bottles/:id/consume` endpoint with
`{reason, rating?, note?}` — no backend changes to that route.

**The one backend ask:** include the bottle id in the urgency-ladder
items so the card knows which bottle to consume. In
`services/statsService.js`, the `urgencyArr.push({...})` block currently
sends `name / producer / vintage / type / price / status` — add:

```js
id: b._id.toString(),
```

Until that ships, the consume button simply doesn't render (the HA card
checks for the field), and the service still works for users who look up
ids themselves — so this is fully backward/forward compatible, same as
the SSE endpoint.

**Worth knowing:** consuming from HA triggers your existing side effects
(rack-slot release, search re-index, audit log `bottle.consume`, restock
check) since it's the same route the app uses.

**Token scopes:** see §3 — the HA integration needs only `read` +
`consume`. A leaked HA config then can't modify wine data beyond marking
bottles consumed.

# 3. API tokens (scoped)

**Status: not yet specced into the HA client — backend leads here.**
Today HA stores the user's **account password** and re-logins on every
token expiry. That's the worst of both worlds: full-privilege credential
at rest in someone's smart-home config, plus a bcrypt hit (~250 ms CPU)
per re-login. Personal API tokens fix both.

## What to build

**Model** — `ApiToken`: `user`, `name` ("Home Assistant"), `tokenHash`,
`scopes: ['read','consume']`, `lastUsedAt`, `createdAt`, `revokedAt`.

- Token format: `cel_` + 32 random bytes hex. The prefix lets the auth
  middleware distinguish API tokens from JWTs at a glance.
- Store **SHA-256 of the token**, never the token. Unlike passwords,
  API tokens are high-entropy random strings — a fast hash is correct
  here and costs microseconds per request instead of bcrypt's 250 ms.
  Show the plaintext token **once** at creation.

**Auth middleware** — in `requireAuth`: if the bearer credential starts
with `cel_`, look up by SHA-256 hash, check `revokedAt`, attach
`req.user` + `req.tokenScopes`, update `lastUsedAt` (throttled, e.g.
once per hour, to avoid a write per request). Otherwise fall through to
the existing JWT path unchanged.

**Scope enforcement** — a `requireScope('consume')` middleware for token
auth; JWT sessions implicitly have all scopes. Initial scopes:

| Scope | Grants |
|-------|--------|
| `read` | all GETs the HA integration uses (stats, cellars, bottles, notifications, events stream, and the rack list `GET /api/racks?cellar=<id>&summary=1` — summary form only: slot bottle ids, details via `GET /api/bottles/:id`) + `GET /api/inventory` (exact path — §4) + `GET /api/auth/whoami` (own account id, no PII — for reauth same-account verification) |
| `consume` | `POST /api/bottles/:id/consume` only |

**Management endpoints + settings UI**

```
POST   /api/tokens          {name, scopes}     → {token: "cel_..."}  (shown once)
GET    /api/tokens          → [{id, name, scopes, lastUsedAt, createdAt}]
DELETE /api/tokens/:id      → revoke (session login)
DELETE /api/tokens/self     → the calling token revokes ITSELF — bearer only, no
                              session and no id; any personal scope (a climate
                              device token is retired via its device instead).
                              For an integration cleaning up when it is removed.
                              Treat 401 as "already gone": it also answers 401
                              while the account is in its deletion cooling-off.
```

Require a fresh password confirmation on create (same pattern as
change-password). Settings UI: a small "API tokens" section listing
name / scopes / last used, with create + revoke.

**Interaction with §1 (SSE):** revoking a token must also drop that
token's open event streams (same `dropUser`-style hook). Since API
tokens don't expire, the "don't kill the stream at token expiry"
concern in §1 disappears entirely for token-authenticated streams.

**Audit:** log `token.created`, `token.revoked`, and (throttled)
`token.used` with the token id — never the token.

## HA side (will follow once this ships)

The integration's config flow will accept an API token as an
alternative to email + password (existing password-based entries keep
working). Nothing here blocks §1 or §2 — this can ship in any order.

## How the HA client behaves (already shipped, for reference)

- Connects on setup; on `404`/`405`/`501`/non-SSE answer → logs once,
  polls normally, re-probes every 6 h.
- While connected: polling relaxed to 6 h; every event triggers one
  debounced REST refresh.
- On disconnect: immediate refresh + reconnect with 30 s → 30 min
  exponential backoff (jittered); >90 s without heartbeat = disconnect.
- On 401 at connect: one re-login attempt, then defers to the polling
  path (which drives HA's reauth flow).

# 4. Inventory

**Status: backend implemented (`routes/inventory.js`); client in
pycellarion 0.2.0 (`get_inventory`) and ha-cellarion (`cellarion.get_bottles`).**
The HA card's search box and its "find a
bottle and take it out" sheet need every bottle at once — with its wine,
its drink window and *where it is* — not the urgency ladder's top five.
One endpoint, read with the same `read` token, kept cheap by a
conditional request.

## Endpoint contract

```
GET /api/inventory
Authorization: Bearer cel_…        (read scope; a normal session works too)
If-None-Match: <the ETag of the copy the client holds>   (optional)
```

| Status | Meaning |
|--------|---------|
| 200 | the inventory (a JSON **object**), with `ETag` and `Cache-Control: no-store` |
| 304 | nothing the inventory holds has changed since that ETag — no body, nothing built |
| 401 | invalid / revoked token (existing re-login / reauth logic) |
| 403 | token without the `read` scope — or an **old server** (the allowlist is default-deny) |
| 404 | an **old server** without the route |
| 429 | per-user limiter (below) |

Clients treat **403 and 404 on this path as "not supported"** and keep
working from the endpoints in §2–3, so the feature can ship on either side
first, like §1.

- **ETag / 304:** the validator is the offline snapshot's
  (`snapshotTag` in `services/offlineSnapshot.js`) salted with
  `inventory:1`, so an inventory tag never equals a snapshot tag. It moves
  with the caller's data version, the version of every owner whose cellar
  is shared with them, which cellars those are, and at least every
  30 minutes (registry edits, curated windows and finished photos reach the
  client within that). Personal-data writes (REST, MCP and their undos) move
  the author's version and the owners' of the cellars where the entry
  shows. The tag is read **before** building; a matching `If-None-Match`
  answers 304 after one small query.
- **Limiter:** 60 requests per user per 10 minutes, 304s included
  (`routes/inventory.js`); 429 beyond that.
- **Scope:** every non-deleted cellar the user owns or is a member of, and
  the bottles still in them (status not in `NOT_IN_CELLAR_STATUSES` — drunk,
  gifted, sold, other and on-order bottles are left out). Nothing about
  other users beyond what the cellar views already show: the username on a
  personal-data entry, as on the bottle page.
- **No AI, ever.** The route is database reads only: no AI provider, no
  embedding, no label scan, no semantic search, no enrichment, no
  Meilisearch. The tasting profile is the one already stored; a wine without
  one gets `null`. (Johan's rule for everything reachable from Home
  Assistant; the consume route follows it too — a token consume's restock
  check compares stored vectors only and never embeds.)

## Response 200

```jsonc
{
  "schema": 1,
  "generatedAt": "2026-10-21T12:00:00.000Z",
  "cellars": [
    { "id": "6aa4…", "name": "Home", "role": "owner" }        // owner | editor | viewer
  ],
  "racks": [
    { "id": "6ab0…", "cellar": "6aa4…", "name": "Left cabinet" }
  ],
  "wines": {                                                   // each wine once; bottles reference it by id
    "<wineId>": {
      "name": "Château X", "producer": "Château X",
      "type": "red",                  // as stored, or null
      "colour": null,                 // colour of a sparkling/dessert/fortified wine, or null
      "country": "France", "region": "Pauillac", "appellation": "Pauillac", "classification": null,
      "grapes": ["Cabernet Sauvignon", "Merlot"],              // display names (regional label), [] when none
      "image": "/api/uploads/thumbs/processed/<uuid>.webp.webp", // registry image as a thumbnail path, or null
      "profile": {                    // stored descriptors only; null when none or held — never the description
        "body": "full", "acidity": "medium", "sweetness": "dry", "tannin": "high",
        "flavors": ["blackcurrant", "cedar"], "foodPairings": ["lamb"]   // ≤ 12 each
      }
    }
  },
  "bottles": [
    {
      "id": "6ac1…",
      "wine": "<wineId>",             // null while the bottle waits on a wine request
      "pending": null,                // { "name", "producer" } of that request when wine is null
      "cellar": "6aa4…",
      "vintage": "2015", "size": "750ml",
      "price": 350, "currency": "SEK",
      "rating": 92, "ratingScale": "100",   // ratingScale only beside a rating, else null
      "notes": "…", "purchaseDate": "2024-05-01", "purchaseLocation": "Systembolaget",
      "addedAt": "2025-01-02T10:00:00.000Z",
      "opened": false,
      "maturity": "peak",             // not-ready | early | peak | late | declining, or null
      "window": { "drinkFrom": 2024, "peakFrom": 2027, "peakUntil": 2032, "drinkTo": 2038 },  // each int or null
      "location": {                   // null when the bottle is in no rack
        "rack": "6ab0…", "rackName": "Left cabinet", "position": 14,
        "shelf": 2, "row": 1, "col": 3
      },
      "place": "Basement, box 3",     // the bottle's free-text location, or null
      "image": "/api/uploads/thumbs/processed/<uuid>.webp.webp",   // the card picture as a thumbnail path, or null
      "personal": [
        { "key": "Closure", "type": "enum", "unit": null, "value": "cork", "level": "bottle", "by": "johan" }
      ]
    }
  ]
}
```

Where each field comes from (`services/integrationInventory.js`):

| Field | Source |
|-------|--------|
| `role` | `getCellarRole` (`utils/cellarAccess.js`) |
| `maturity` | `classifyMaturity` over `buildProfileMap` — the same status the bottle lists and `GET /api/bottles?maturity=` use |
| `window` | `resolveEffectiveWindow` (`utils/maturityUtils.js`): the bottle's own window when any of it is set, else the reviewed sommelier profile; `drinkFrom` = early-from (else peak-from), `drinkTo` = late-until (else peak-until) |
| `location` | the rack slot holding the bottle; `shelf` / `row` / `col` from `slotLocation` (`utils/rackGeometry.js`): cabinets → shelf (1 = top), row within the shelf (1 = on the plank, counting up; two deep: 1 front, 2 back, 3 the next level's front …), col (slot in that row, left to right); grids → row and col of the row-major grid (a double-height row's top layer: that row, and its place in the top layer); other rack types and modular racks → `null`s, `position` still set |
| `image` (bottle) | the cellar list's resolver (`attachBottleImageUrls`), in the card's order: chosen default → the user's own photo of this bottle or vintage → the vintage's official photo → the registry image → the user's photo of another vintage |
| `image` (both) | thumbnail paths only: `/api/uploads/(processed\|originals)/<name>.<png\|jpg\|jpeg\|webp>` on this instance → `/api/uploads/thumbs/<dir>/<name>.<ext>.webp` (`utils/thumbPath.js`). An external link, an inline `data:` image or another host's upload → `null`, so a client never fetches a URL someone stored. The uploads mount is public: fetch the path without credentials |
| `personal` | `personalData.listForBottles` — exactly the bottle page's rules: bottle-level entries by anyone; wine-level entries by current members of the bottle's cellar, vintage-scoped ones only on bottles of that vintage |

Loaded lean: every query names its fields, so the heavy bottle fields
(cellar history, pours, barcode, purchase URL …), slot RFID tags and the
registry's prose and curation bookkeeping are never read.

Deep link to a bottle in the app: `{instance}/cellars/{bottle.cellar}/bottles/{bottle.id}`.
