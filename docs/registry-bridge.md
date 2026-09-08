# Registry Bridge (protocol v1)

The Registry Bridge lets a self-hosted Cellarion use the shared wine registry on
cellarion.app without ever receiving the registry as a whole. Think of a bonded
warehouse: the goods stay inside, an install holds a permit, draws out the single
wines its owner actually adds, and can send goods back in (requests, corrections,
values read from labels). There is no bulk endpoint, no snapshot and no global
change feed, by design.

The code is open (this repository, AGPL-3.0); access is closed: keys are issued to
verified accounts under the [Registry Data Terms](https://cellarion.app/terms), are
revocable, and are subject to quotas and the same reading counters as every other
reader.

## Getting a key

1. Sign in on cellarion.app, open **Settings → Connect a self-hosted Cellarion**.
2. Accept the Registry Data Terms, name your install, confirm your password.
3. Copy the two lines into your install's `.env` and restart the backend:

```
REGISTRY_BRIDGE_URL=https://cellarion.app
REGISTRY_BRIDGE_KEY=cbr_…
```

Two keys per account. The key is shown once; only its hash is stored.

## Requests

All routes live under `https://cellarion.app/api/bridge/v1`, need
`Authorization: Bearer cbr_…`, and accept an optional `X-Cellarion-Instance: <host>`
header that names your install in the readers report and on contributions.

| Route | Purpose | Quota (per key, per UTC day) |
|---|---|---|
| `GET /me` | Key, quotas and today's spend | — |
| `GET /search?q=` | Up to 10 identities matching `q` (2–120 chars) | 600 |
| `GET /wines/:id` | One wine in full: identity, profile, reviewed drink windows, published values | 300 |
| `POST /wines/changes` | `{ ids: [≤5000], since: ISO }` → which of those changed, which were removed | 1 |
| `POST /requests` | `{ wineName, sourceUrl, image? }` → a wine request into the hosted queue | 50 (shared) |
| `POST /corrections` | `{ wineId, fields, reason, evidenceUrl }` → an admin-reviewed proposal | 50 (shared) |
| `POST /values` | `{ wineId, keyName \| keyId, value, reason, evidenceUrl, vintage? }` → a value suggestion | 50 (shared) |

Burst limit: 60 requests per minute per key. Once per 30 days the owner can open an
**import window** from Settings that multiplies every daily quota by five for 24
hours, for importing a whole cellar.

### Responses

- Search items: `{ id, slug, producer, name, type, appellation, classification, region, country, grapes, image, imageCredit }`. Identities only; no profiles travel in search results.
- A wine: the identity above plus `lwin`, `communityRating`, `updatedAt`, `profile` (`body`, `tannin`, `acidity`, `sweetness`, `flavors`, `foodPairings`, `description`, `source`, `generatedAt`, `verifiedAt`), `windows` (per vintage: `early`, `peak`, `late` phases; `relative: true` rows hold year offsets from purchase for non-vintage wines) and `values` (published registry values: `key`, `value`, `wineValue`, `overrides`).
- Changes: `{ since, checkedAt, checked, changed: [{ id, updatedAt }], removed: [id] }`. `removed` means the id no longer exists as a wine (merged away or quarantined); keep your local copy and stop refreshing it.
- Errors: `401 no_key | invalid_key`, `400 invalid`, `404 not_found`, `409 conflict`, `429 quota | burst | rate_limited` (with `resetAt` on quota), `403 banned`.

Images are referenced by URL, never sent as bytes.

## What never crosses

Bulk listings or paging of the registry, snapshots or exports, a feed of all changes,
embeddings and the similarity graph, sommelier notes behind a drink window, canary
rows, curator identities.

## How reading is watched

Every wine fetched through a key is counted as a distinct wine for that key and day,
alongside every other reader of the registry. The daily readers report names keys
that read far beyond a household's pace, and a fetch of a canary wine (a wine that
exists only to detect copying, never reachable through search or add-bottle) alerts
the admins immediately. A key that walks the registry is revoked and the account
flagged; the terms every key holder accepted cover the rest.

## Privacy

A key and its usage counters are personal data of the account holder: they are in
the account export, deleted with the account, and usage rows expire after 90 days.
Your users' own bottles never travel over the bridge; only registry records and the
contributions you choose to forward.

## Client side (what a connected install does)

With the two `.env` lines set, the self-hosted backend switches its bridge client on
(`backend/src/services/registryBridgeClient.js` for transport,
`backend/src/services/registryBridge.js` for the logic). Nothing changes for its
users until they search.

- **Add-bottle search.** Local results come first, as before. Below them, under
  "From the shared registry", up to ten identities that this install does not hold
  yet (already-copied wines are filtered out). The same applies on the wishlist page.
  Searches are cached for a minute per query so quota is not spent on every keystroke.
- **Adoption.** Picking a registry row calls `POST /api/bridge/adopt` on the install,
  which fetches that one wine and creates a local wine with `createdVia: 'bridge'`
  and `registryId` set: identity, tasting profile, reviewed drink windows (as
  reviewed rows) and published values (keys are matched by name locally, created as
  accepted when missing). The dedup key is computed the same way a typed wine gets
  it, so a later manual add finds the copy instead of creating a twin. A local wine
  typed earlier with the same key is linked, not duplicated, and a locally curated
  profile is kept. The label image is a URL into cellarion.app, never copied.
- **Local enrichment stays away.** The install's own AI enrichment skips wines with
  `registryId`; the registry's profile is the source of truth for them.
- **Weekly refresh.** Monday 06:30 UTC the install sends the ids it holds (one
  change check; chunks of 5,000) and re-fetches the changed ones. Profile, windows,
  values and image follow the registry; identity fields follow it only when the copy
  has not been edited locally since the last sync. Wines the registry reports removed
  are marked `registryRemovedAt` and left alone.
- **Contributions flow back.** A field correction or a value suggestion filed on the
  install for an adopted wine is also sent to the hosted queues, and a new-wine
  request is forwarded too. All fire-and-forget: the local record stands alone if the
  hosted side is unreachable.
- **Settings.** A "Shared wine registry" card shows the connection (key prefix, copies
  held, today's quota use, last refresh) or, when not connected, the three steps.

Failure mode is always local-only: a missing key, a bad key, a quota refusal or a
network problem never produces an error on add-bottle, only fewer results. Quota and
key refusals pause the client's requests for a few minutes so a closed door is not
hammered; the Settings card says so.
