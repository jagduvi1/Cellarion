# Wine Valuation Spec

**Status:** Draft for review · **Date:** 2026-06-05

Two complementary ways to put a "value" on a bottle, each answering a different
question and using a different data source. Neither uses a paid external API —
the whole feature runs on data Cellarion already collects plus the existing
sommelier flow, so it stays free.

---

## The two questions

| | **Track A — Release price** | **Track B — Secondary-market value** |
|---|---|---|
| **Answers** | "What does this wine cost *now* (current vintage)?" | "What is *this specific old vintage* worth on the resale/auction market?" |
| **Applies to** | Every wine | Valuable/collectible wines only |
| **Source** | Community: aggregate of what Cellarion users actually paid | Sommelier, curated on user request (existing flow) |
| **Trigger** | Automatic | User presses **Request price** button (opt-in) |
| **Cost** | $0 (own data) | $0 (sommelier labour) |
| **Status** | **New** (this spec) | **Already built** — keep as-is |

A wine can use **both**. For a 2019 Barolo: Track A says the current release
(2022) costs ~625 kr; if it's collectible, the owner requests a valuation and a
sommelier supplies the 2019's secondary-market value (which may exceed 625 kr).

### Guiding principles
1. **An ordinary bottle's own value = what the user paid.** It has no secondary
   market and doesn't move — never invent a market value for it.
2. **The interesting number for ordinary wine is the current release price** —
   what the latest vintage of the same wine costs today (≈ replacement value).
3. **Never aggregate prices across currencies.** Currency + tax + FX make
   cross-border purchase prices incomparable. Bucket by currency so every
   comparison is same-currency / same-tax by construction (see §A.3).

---

## Track B — Secondary-market value (existing, unchanged)

Keep the current flow exactly as-is. Documented here only so Track A doesn't
collide with it.

- **Models:** [`PriceTrackingRequest`](../backend/src/models/PriceTrackingRequest.js)
  (opt-in, singleton per `wineDefinition`+`vintage`, `requesters[]`),
  [`WineVintagePrice`](../backend/src/models/WineVintagePrice.js)
  (append-only somm-curated price snapshots).
- **User trigger:** `POST /api/bottles/:id/request-price-tracking`
  ([bottles.js:844](../backend/src/routes/bottles.js#L844)) — the **Request
  price** button stays.
- **Sommelier side:** queue + curation in
  [`somm/prices.js`](../backend/src/routes/somm/prices.js); requesters notified
  on save.

**No changes** to Track B in this spec. The only frontend touch is labelling
(§Display) so users understand it's "secondary-market value of *this* vintage,"
distinct from Track A's "current release price."

---

## Track A — Community release price (new)

### A.1 Data model — `CommunityWinePrice`

A **derived aggregate**, one document per `(wine, vintage, currency)`,
recomputed on a schedule. Kept in its own collection so the somm-curated
`WineVintagePrice` stays pristine (different cardinality, trust, and lifecycle).

```js
// backend/src/models/CommunityWinePrice.js
{
  wineDefinition: { type: ObjectId, ref: 'WineDefinition', required: true, index: true },
  vintage:        { type: String, required: true },          // 'NV' allowed
  currency:       { type: String, uppercase: true, required: true },

  medianPrice:    { type: Number, required: true },          // in `currency`, tax-inclusive as paid
  sampleSize:     { type: Number, required: true },          // DISTINCT owners (not bottles)
  confidence:     { type: String, enum: ['indicative', 'firm'], default: 'firm' },
  p25:            { type: Number },                          // optional, for a range chip
  p75:            { type: Number },

  computedAt:     { type: Date, default: Date.now }
}
// unique index: { wineDefinition: 1, vintage: 1, currency: 1 }
// query index:  { wineDefinition: 1, currency: 1, vintage: -1 }  // newest vintage first
```

### A.2 Aggregation + cleaning job — `communityPriceJob.js`

Mirror the pattern of
[`cellarValueSnapshotJob.js`](../backend/src/services/cellarValueSnapshotJob.js);
register in [`scheduler.js`](../backend/src/services/scheduler.js). Run
**weekly** — release prices are stable, so this is cheap and barely moves.

Process **a whole wine's vintages together, per currency** (`(wine, currency)`),
so the price *curve* can cross-validate itself — this is what makes the feature
useful before any vintage has 3 owners.

1. **Gather** active bottles (`status` not in `CONSUMED_STATUSES`, `price > 0`)
   for the wine in this currency, grouped by vintage.
2. **One value per owner.** Reduce each user's bottles of a vintage to a single
   representative price (their median), so a user with 12 identical bottles
   can't dominate. Per-vintage `sampleSize` = distinct owners.
3. **Absolute cleaning.** Run every value through the existing
   [`priceValidation.js`](../backend/src/utils/priceValidation.js) /
   [`priceWarnings.js`](../backend/src/services/priceWarnings.js) (negatives,
   100×, cents-as-units).
4. **Cross-vintage consistency — the cold-start cleaner.** Ordinary wine is
   price-stable across vintages, so the curve validates itself even at one value
   per vintage:
   - Robust center `C` = median *across vintages* of each vintage's
     representative price (median-of-medians), within this currency.
   - Flag a vintage **suspect** if its value `> 4×C` or `< C/4`. The wide band
     catches decimal/zero typos (e.g. `5600` entered for `560`) while still
     allowing genuine good-vs-poor-vintage variation (rarely beyond ~3×).
   - Needs ≥2 vintages for `C` to mean anything. With fewer, rely on the
     absolute checks only and mark the value `indicative`.
   - Suspect single-owner vintages are **not written** (and can optionally be
     surfaced back to the owner as a "this looks off — typo?" hint, reusing the
     `priceWarnings` tone).
5. **Within-vintage aggregation** sets the confidence tier:
   - `sampleSize >= 3` → median + 1.5×IQR trim → **`firm`**.
   - `sampleSize` 1–2 (cleaned, not suspect) → keep the value → **`indicative`**.
6. **Upsert** each non-suspect vintage's `CommunityWinePrice` (`medianPrice`,
   `sampleSize`, `confidence`, `computedAt`) via `bulkWrite`.

Work is bounded by the number of `(wine, currency)` combos with active bottles —
small and slow-growing. `confidence` is **a trust label, not a privacy gate**:
community prices are published *unattributed* (like shared images — see GDPR), so
even an `indicative` (N=1) value is shown to all users, just flagged as
low-confidence. Accuracy is protected by the cross-vintage cleaner (step 4), not
by withholding the value.

### A.3 Currency / tax — solved by partitioning, not correcting

Each curve is **per currency**, so:
- **FX disappears** — no conversion happens inside a bucket.
- **Tax mostly self-isolates** — the extreme-tax markets (Sweden SEK, Norway
  NOK, Denmark DKK, UK GBP) each have their *own* currency, so they never blend
  with the low-tax Eurozone. A Swedish user sees the SEK curve (tax-inclusive,
  as they'd actually rebuy it); a French user sees EUR.
- **Bucket key = `Bottle.currency`** (already stored per bottle —
  [Bottle.js:45](../backend/src/models/Bottle.js#L45)). No new field needed.

**Known, accepted limitations** (tolerable for a clearly-labelled *estimate*;
documented, not hidden):
- The intra-Eurozone VAT spread (~19–25%) is not corrected, and a single
  currency can span tax jurisdictions (USD across US states).
- **Bottle size.** Phase 0 pools all sizes into one (wine, vintage, currency)
  median, so a magnum (~2× a 750ml) skews it. *Next refinement:* either filter
  the curve to standard 750ml or bucket by `bottleSize`. Flagged by the first
  real-data run (a SEK curve spanning 240→2899 partly reflects mixed sizes).

**Ops:** the job runs weekly via the scheduler; run it on demand (after an
import, or to verify) with `docker exec cellarion-backend node
src/runCommunityPrices.js`.

### A.4 Value resolution

```
resolveBottleValue(bottle, displayCurrency):
  paid          = { amount: bottle.price, currency: bottle.currency }      // always shown, never aggregated
  currentRelease = newest non-suspect vintage of bottle.wineDefinition in   // Track A
                   bottle.currency — prefer `firm` (N>=3); fall back to
                   `indicative` (N=1-2) only with a low-confidence label
  secondary      = latest WineVintagePrice for (wineDefinition, bottle.vintage)  // Track B, if requested
```

- **Bottle "value" (headline) = `paid`.** Stable, honest, no FX/tax issue.
- **`currentRelease`** = replacement signal ("current release ~625 kr").
- **`secondary`** shown only when a sommelier has supplied it.
- **Cellar replacement total** (optional aggregate): per bottle use
  `secondary ?? currentRelease ?? paid`, convert to `displayCurrency` with
  [`exchangeRates`](../backend/src/utils/exchangeRates.js) at **today's rate**,
  flagged "converted at today's rate." This is the *only* place FX enters.

**Fallback ladder** when no same-currency community data exists:
1. Newest `firm` (N≥3) vintage in the bottle's currency →
2. else newest `indicative` (N=1–2, curve-validated) vintage, shown with a
   low-confidence label →
3. else show "current release: —" and fall back to `paid` →
4. *(optional, later)* a clearly-labelled AI estimate via the existing
   [`suggestPrice()`](../backend/src/services/labelScan.js), cached.

> **Vintage granularity:** keep per-vintage (the curve *is* the interesting
> output — "what next and next vintage cost"). Do **not** pool vintages by
> default. If sparsity bites, an optional mitigation is pooling *adjacent*
> vintages — but the per-vintage curve is the goal.

---

## API

| Method | Path | Status | Purpose |
|---|---|---|---|
| `GET` | `/api/wines/:id/community-prices?currency=SEK` | **new** | Per-vintage release-price curve for the sparkline + current-release chip |
| — | bottle detail response | **extend** | Add `value: { paid, currentRelease, secondary }` |
| `POST/DELETE/GET` | `/api/bottles/:id/request-price-tracking` | unchanged | Track B request button |
| `*` | `/api/somm/prices/*` | unchanged | Track B curation |

`GET /api/wines/:id/community-prices` returns, for the requested currency,
`[{ vintage, medianPrice, sampleSize, p25, p75 }]` newest-first, plus the
derived `currentRelease`.

---

## Frontend display ([BottleDetail.js](../frontend/src/pages/BottleDetail.js))

```
You paid           550 kr   · 2019 · Mar 2021
Current release   ~625 kr   · 2022 · based on 6 SEK buyers   ↗  [▁▂▃▅ sparkline]
Secondary value    720 kr   · 2019 · sommelier · 12 May 2026   (+170 kr / +31% vs paid)
                   └─ only if requested;  [ Request price ] button otherwise
```

- **You paid** — always; the headline bottle value.
- **Current release** — Track A; chip shows `sampleSize` for trust ("based on N
  SEK buyers"); sparkline = the per-vintage curve.
- **Secondary value** — Track B; only when a sommelier has supplied it,
  otherwise the existing **Request price** button (relabel for clarity, e.g.
  "Request market valuation").
- **Statistics / cellar:** add an "estimated replacement value" line alongside
  the existing cost-basis total. Extend
  [`CellarValueSnapshot`](../backend/src/models/CellarValueSnapshot.js) with a
  `replacementValue` field (keep `totalValue` = cost basis for back-compat) and
  have [`cellarValueSnapshotJob.js`](../backend/src/services/cellarValueSnapshotJob.js)
  compute both.

---

## GDPR

- **Published unattributed — like a shared image.** A community price is shown
  with no link to who entered it, exactly as a shared
  [`BottleImage`](../backend/src/models/BottleImage.js) is shown without
  exposing its uploader. A price is a fact about a *product*, not a person, so
  an unattributed value — even from a single owner — is not personal data on
  display. (The contributor's own raw price stays their personal data and
  remains in their `GET /api/users/me/export`.)
- **Contribution opt-out (courtesy).** Like images, prices feed the shared pool
  by default. A `contributeToCommunityPricing` preference (default on) is still
  worth adding as a right-to-object safeguard — honoured by excluding opted-out
  users' bottles from aggregation. Note in
  [PrivacyPolicy.js](../frontend/src/pages/PrivacyPolicy.js). Not blocking.
- **Export:** the user's own prices are already in
  `GET /api/users/me/export` — unchanged.
- **Deletion:** deleting an account removes its bottles, so they drop out of the
  next recompute automatically. No extra cascade needed.
- **Audit:** the weekly job logs a summary via
  [`services/audit.js`](../backend/src/services/audit.js).

---

## Phasing

- **Phase 0 — community pricing core (no Track B changes).**
  `CommunityWinePrice` model + `communityPriceJob` + bottle-detail
  `currentRelease` chip and sparkline. Ships the "what the next vintage costs"
  feature with zero new dependencies.
- **Phase 1 — replacement value.** `replacementValue` on the snapshot + a
  Statistics line + the cellar replacement total (with the flagged today's-rate
  conversion).
- **Phase 2 — polish.** Opt-out preference + privacy-policy update; optional
  AI fallback for current release when no community data; optional adjacent-
  vintage pooling for sparse currencies.

---

## Open decisions (defaults proposed)

1. **Confidence thresholds** — propose `firm` at **N≥3** owners, `indicative` at
   **N=1–2** (cleaned + curve-validated). Cleaning itself works at N=1.
2. ~~Show `indicative` prices to other users?~~ **Resolved:** yes. Community
   prices are published *unattributed* (like shared images), so N=1 values are
   shown to all with a low-confidence label. `firm`/`indicative` is a trust
   signal, not a privacy gate; cross-vintage cleaning stops bad values showing.
3. **Cross-vintage suspect band** — propose flag if `>4×C` or `<C/4`; tighten as
   data grows.
4. **Recompute cadence** — propose **weekly**.
5. **`CommunityWinePrice` vs reusing `WineVintagePrice`** — propose **separate
   collection** (keeps the somm flow untouched; different lifecycle).
6. **AI fallback for current release** — defer to Phase 2 (start data-only).
7. **Request-button relabel** — "Request market valuation" vs keep "Request
   price." Cosmetic.
