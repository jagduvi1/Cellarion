# Admin Global Stats — How It Works

The `/admin/stats` page surfaces platform-wide, anonymised statistics across every Cellarion user in a single dashboard. It's the answer to questions like *"how many bottles are tracked?"*, *"where are people losing trial subscriptions?"*, and *"what's our drink-window-coverage rate?"* — without writing ad-hoc Mongo queries.

The page is admin-only, has zero per-user PII in its responses, and exists so the same numbers can feed blog posts, press, and product reporting from one source of truth.

---

## High-Level Flow

```
Admin opens /admin/stats
    │
    ▼
┌────────────────────────────────┐
│  GET /api/admin/stats/global   │  requireAuth + requireRole('admin')
│    ?excludeAdmins=true|false   │
│    ?force=true|false           │
└──────────────┬─────────────────┘
               │
               ▼
┌────────────────────────────────┐
│   In-memory cache lookup       │  Key: 'true' | 'false' (excludeAdmins)
│   TTL: 5 minutes               │  force=true bypasses
└─────┬──────────────────────────┘
      │ miss
      ▼
┌────────────────────────────────┐
│   Resolve admin filter chain   │  If excludeAdmins, fetch admin user IDs
│   (one User.find at the top)   │  + admin cellar IDs, build $nin filters
└──────────────┬─────────────────┘
               │
               ▼
┌────────────────────────────────┐
│   Run ~20 aggregations in      │  Bottle, Cellar, User, WineDefinition,
│   parallel (Promise.all)       │  WineVintageProfile, WineRequest,
│                                │  BottleImage, Rack
└──────────────┬─────────────────┘
               │
               ▼
┌────────────────────────────────┐
│   Cache the payload, return    │  fromCache=false on the first hit;
│   { ...stats, fromCache: bool }│  true for every subsequent caller
└────────────────────────────────┘
```

---

## Sections (14)

The payload is structured so the frontend can render each section independently.

| Section | What it shows | Source |
|---|---|---|
| **Overview** | Users, cellars, bottle counts (active / consumed / drank / gifted / sold / other), avg per user, avg per cellar, unique WineDefinitions | `Bottle.countDocuments` + `Cellar.countDocuments` + `User.countDocuments` |
| **Engagement** | Active users 24h / 7d / 30d / 90d (added or consumed a bottle in the window) | `Bottle.aggregate $group` per window |
| **Recent activity** | New users + bottles added + bottles consumed in 30d / 90d | Date-filter counts |
| **12-month trends** | Monthly series (back-filled to always emit 12 entries) for bottles added, consumed, new users, new cellars | `$dateToString` group, then JS back-fill |
| **Subscriptions** | Plan distribution, paid users, trial-eligible, plans expiring in 7d/30d, Stripe-customer count | `User.aggregate $group` on `plan` |
| **Drink-window maturity** | Bottles classified peak / early / not-ready / late / declining via `$lookup` → `$switch` against the current year. Plus profile-coverage %. | See *Maturity classification* below |
| **Quality & ratings** | Avg rating normalised to 0–100, distribution histogram, avg by wine type | `$switch` for cross-scale normalisation |
| **Vintage** | Avg vintage age, oldest/newest, by-decade distribution | `$convert: to: 'int'` + `$bucket`-style group |
| **Composition** | Top 15 countries / regions / grapes / producers + by-type breakdown | `$lookup` chains over WineDefinition |
| **Most-collected wines** | Top 10 wines by bottle count | `$group` on `wineDefinition` |
| **Most expensive bottles** | Top 10 individual bottles by price, **anonymised + redacted on small platforms** | See *Privacy guards* below |
| **Value by currency** | Count / avg / median / total / max grouped by currency (no cross-rate noise) | `$group` per currency + JS median |
| **Library health** | Wine-definition coverage, profiles total/reviewed/pending, pending wine requests + image reviews, total images + racks | Misc counts on `WineDefinition`, `WineVintageProfile`, `WineRequest`, `BottleImage`, `Rack` |
| **Patterns** | Holding-time distribution, cellar-size distribution, bottle-size distribution (with rollup of `750ml` variants) | `$bucket` on derived day-diffs + cellar size |

---

## Maturity Classification

Bottle maturity is the Cellarion USP made visible. The pipeline joins active bottles with their reviewed `WineVintageProfile` and runs the same classifier as `utils/maturityUtils.js#classifyMaturity` — *in Mongo* — via a pipeline-side `$switch`.

```
{ $match: { status: 'active', ...bottleMatch } }
    │
    ▼
{ $lookup: 'winevintageprofiles'  (sub-pipeline matches wd+vintage+reviewed) }
    │
    ▼
{ $unwind: { preserveNullAndEmptyArrays: true } }
    │
    ▼
{ $addFields: { maturity: $cond + $switch } }
    │
    ▼
{ $group: { _id: '$maturity', count: $sum 1 } }
```

The classifier has two guard branches before the switch:

1. **`profile == null`** → `noProfile` (no review yet)
2. **Reviewed profile with all `earlyFrom` / `peakFrom` / `peakUntil` null** → `noProfile`. Partial profiles are real (every year field is optional on `WineVintageProfile`), and earlier versions defaulted these into `peak` and inflated the bucket.

The default fall-through is `'early'`, matching `classifyMaturity`'s final `return 'early'`. **This is load-bearing** — an earlier version defaulted to `'peak'` and reported peak counts that were 5-30 % too high in the test data.

---

## `excludeAdmins` filter chain

When set via `?excludeAdmins=true`, admin-owned data is filtered out of every per-user statistic. Useful for a customer-only view that ignores test/admin data.

Resolution happens **once** at the top of the request, then the same `$nin` clauses thread through every aggregation:

```
admins = User.find({ roles: 'admin' }).distinct('_id')
    │
    ▼
adminCellarIds = Cellar.find({ user: $in: admins }).distinct('_id')
    │
    ▼
┌─ userMatch    = { roles: $nin: ['admin'] }
├─ bottleMatch  = { user:   $nin: adminIds }
├─ cellarMatch  = { user:   $nin: adminIds }
├─ imageMatch   = { uploadedBy: $nin: adminIds }
├─ requestMatch = { user:   $nin: adminIds }
└─ rackMatch    = { cellar: $nin: adminCellarIds }   ← indirect chain
```

`WineDefinition` and `WineVintageProfile` are **not filtered** — they're shared platform reference data, curated by admins by design.

The response echoes `excludeAdmins` and `adminsExcludedCount` so the UI can show *"3 admins hidden"* next to the toggle.

---

## Caching

`computeGlobalStats` wraps an in-memory `Map` cache:

- Key: `String(excludeAdmins)` → `'true'` or `'false'` (two slots only)
- TTL: 5 minutes
- Returns `{ ...payload, fromCache, cachedAt }` so the UI can show a *"cached"* tag next to the timestamp
- `?force=true` bypasses the cache and recomputes fresh. The page's **Refresh** button sends this flag

**Why bother?** Each call runs ~20 aggregations plus an in-memory median sort per currency. Admin traffic is low, but a curious admin holding Cmd-R would otherwise hammer Mongo and inflate the median-resort cost (an O(n log n) sort of every priced bottle per currency).

---

## `$bucket` label trap

`$bucket` only emits buckets that contain at least one document — empty middle buckets are silently omitted. The first version of the service mapped results by array index, which meant an empty `1–2yr` bucket would shift every later label down (the real `2–5yr` count appeared labelled `1–2yr`).

Now: every bucket-using section (`holdingTime`, `cellarSizeDistribution`, `ratingDistribution`) defines a `[{ id, label }]` table and looks up rows by `_id` (the lower-boundary value) rather than by index.

Rows with `count: 0` are filtered out on the frontend so the page doesn't show `0%` clutter.

---

## Privacy guards

- **No PII** is ever in the response. All figures are counts, averages, or distributions.
- **Most-expensive-bottles** could fingerprint a single owner on small platforms. When `usersWithBottles < 25`, the wine name + producer + vintage are redacted; only the price + currency are shown. The frontend renders *"(hidden — small user base)"* with a banner explaining why.
- **Inline `String()` + `HEX24` sanitisation** on every value that comes from `req.body` before it reaches a Mongo `$match`. Defuses NoSQL operator injection at the resolver boundary (`computeUserMediansByCurrency`, `findUserMedian`, `findMarketMedian`).

---

## Key Files

| File | Role |
|---|---|
| `backend/src/services/globalStatsService.js` | All 20 aggregations + cache wrapper + admin-exclude resolver |
| `backend/src/routes/admin/stats.js` | `GET /api/admin/stats/global`, `requireAuth + requireRole('admin')`, query-param parsing |
| `backend/src/utils/maturityUtils.js` | Canonical `classifyMaturity` — the maturity `$switch` mirrors this |
| `frontend/src/pages/AdminStats.js` | Section-based dashboard, `excludeAdmins` toggle, force-refresh, bar charts |
| `frontend/src/pages/AdminStats.css` | Stat cards, bar charts, horizontal bars, warn/ok accents |
| `frontend/src/api/admin.js` | `adminGetGlobalStats({ excludeAdmins, force })` client |
| `frontend/src/locales/{en,sv}/translation.json` | `adminStats.*` namespace |
