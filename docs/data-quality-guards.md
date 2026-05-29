# Data Quality Guards at the Bottle-Entry Boundary

Cellarion's data is only as good as what users enter. Two guard rails sit at the moments a price (or any number) crosses into the database:

1. **`parseLocaleNumber`** — locale-aware number parser used by every CSV import path. Replaces `parseFloat` to fix systematic under-counting on EU/Swedish exports.
2. **Price sanity warnings** — four deterministic rules surfaced as non-blocking warnings on the add-bottle form and the import preview. Catches 100×-too-high fat-finger errors before they pollute the dataset.

Both ship as **Tier 1** of the data-quality plan: no AI, no external service, pure rules. The plan tracks Tier 2 (LLM batch validation) and Tier 3 (real-time LLM-in-the-loop) as additive layers if rule-based ever stops being enough.

---

## Why this exists

A single user added 27 bottles with prices ranging from $14,000 to $260,000 USD — all exactly 100× too high (Opus One at $50k, Chevalier-Montrachet GC at $260k). It dragged the global avg USD bottle price to $7,731 and made the /admin/stats *"most expensive"* leaderboard read like a Sotheby's catalogue.

Investigation showed two distinct failure modes:

| Mode | Cause | Visible symptom |
|---|---|---|
| **Over-counting** | Manual entry slip (extra zero) or unit mismatch | $260,000 for a $2,600 wine |
| **Under-counting** | `parseFloat('1.234,56')` returns `1.234` on EU CSV exports | Bottle sizes show as `0ml`, prices off by 1000× |

The two fixes attack each mode at the source.

---

## `parseLocaleNumber` — Locale-aware number parsing

### The bug

`parseFloat` understands US format only and silently stops at the first non-numeric character:

| Input | `parseFloat` returns | Should be |
|---|---|---|
| `'1234.56'` | 1234.56 ✓ | 1234.56 |
| `'1,234.56'` | **1** ✗ | 1234.56 |
| `'1.234,56'` | **1.234** ✗ | 1234.56 |
| `'1 234,56'` | **1** ✗ | 1234.56 |
| `'0,75'` | **0** ✗ | 0.75 (a 750ml bottle in litres) |
| `'$25.00'` | **NaN** ✗ | 25 |

Every Vivino export from a Swedish/German user, every Systembolaget price list, every Oeno-by-Vintec export in EU locale was silently mis-parsing prices and bottle sizes — without any error.

### The rules

```
Input → trim, strip currency symbols + whitespace
    │
    ▼
┌────────────────────────────────┐
│  Has both ',' and '.' ?         │
│   yes → last one is the decimal │
│         (US "1,234.56"  or EU "1.234,56") │
│   no  → continue                          │
└──────────┬─────────────────────┘
           │
           ▼
┌────────────────────────────────┐
│  Has ',' only ?                            │
│   parts.length > 2  → US thousands         │
│   one comma, 3 digits after, integer > 0   │
│                     → US thousands ("1,234" → 1234) │
│   otherwise         → EU decimal           │
└──────────┬─────────────────────┘
           │
           ▼
┌────────────────────────────────┐
│  Has '.' only ?                            │
│   parts.length > 2  → EU thousands         │
│                       ("1.234.567" → 1234567) │
│   one period        → US decimal (parseFloat handles) │
└────────────────────────────────┘
```

### Two ambiguity rules worth knowing

| Input | Treated as | Why |
|---|---|---|
| `'1,234'` | US thousands → **1234** | Vivino/CellarTracker exports use this format extensively for unquoted numbers. EU decimals with three fractional digits are rare in wine pricing. |
| `'0,375'` | EU decimal → **0.375** | Leading zero means it's almost certainly a bottle size in litres (375ml). The thousands interpretation makes no sense. |

The leading-zero check on commas protects the bottle-size import path without giving up the more common Vivino case.

### Applied where

Five call sites in `frontend/src/utils/importMappers.js`:

| Mapper | What now uses `parseLocaleNumber` |
|---|---|
| Vivino | `price`, `rating` |
| CellarTracker | `price`, `rating` |
| Generic CSV | `price`, `rating` |
| Cellarion native | every numeric field via the `num()` helper |
| Oeno-by-Vintec | `Bottle Size Liters`, `Purchase Cost` |

Integer fields (`Quantity`, rack positions) keep using `parseInt` — always whole, no separator ambiguity.

### Locked-in regression tests

Each of the four parseFloat bugs is now an explicit assertion in `frontend/src/utils/importMappers.test.js`:

```js
expect(parseFloat('1.234,56')).toBe(1.234);     // bug locked in
expect(parseLocaleNumber('1.234,56')).toBe(1234.56);

expect(parseFloat('0,75')).toBe(0);             // bug locked in
expect(parseLocaleNumber('0,75')).toBe(0.75);
```

If anyone ever swaps `parseLocaleNumber` back for `parseFloat`, these tests fail loudly.

---

## Price Sanity Warnings — Four Rules

Non-blocking warnings shown to the user as a price is being entered. Saves always succeed; the warning is a hint that something might be off.

### The four rules

| Rule | Severity | Fires when | Caught the incident? |
|---|---|---|---|
| `absoluteCap` | warning | price > typical per-currency max ($50k USD, 500k SEK, etc.) | ✓ (caught the $260k Chevalier-Montrachet) |
| `userOutlier` | warning | price ≥ 50× user's own median in same currency (sample ≥ 5) | ✓ (Opus One $50k when user median is ~$500) |
| `aboveMarket` | warning | price ≥ 5× recorded WineVintagePrice for this wine+vintage in same currency | ✓ (when somm-curated price exists) |
| `possiblyCents` | info | price ≥ 10,000 AND divisible by 100 — hints user may have entered cents | ✓ (informational nudge) |

Multiple rules can fire on one bottle. The Chevalier-Montrachet case stacks all four.

### Where they fire

```
┌──────────────────────────────────────────────────────────┐
│  Add Bottle form                                          │
│   User types in the price field                           │
│   → frontend/src/utils/priceValidation.js                 │
│   → warnings under the price input update LIVE            │
│   → no round-trip needed (rules are pure)                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Import preview                                           │
│   POST /api/bottles/import/validate                       │
│   → backend computes per-currency user medians ONCE       │
│     (single Mongo aggregation, no N+1)                    │
│   → annotates each result row with priceWarnings[]        │
│   → summary stat 'Price warnings' + banner at top         │
│   → ⚠️ on each affected price detail-tag, hover for why    │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  POST /api/bottles (single bottle save)                   │
│   → backend gathers warnings with user + market context   │
│   → returns { bottle, priceWarnings } — never blocks save │
└──────────────────────────────────────────────────────────┘
```

The frontend rules are a **mirror** of the backend rules in the same repo. Keep both in sync — they live in `backend/src/utils/priceValidation.js` and `frontend/src/utils/priceValidation.js`.

### Why pure rules, not AI

For Tier 1 the answer is *because we don't need AI*:

- Rules are deterministic, instantly testable, zero ongoing cost
- 20 unit tests cover every rule + every edge case + the production-incident scenario
- A 100× price error is mechanically catchable without semantic understanding
- AI would buy nothing extra at this level

The tiered plan is:

| Tier | What | Status |
|---|---|---|
| **1** | Pure rule-based warnings (this PR) | Shipped |
| **2** | Nightly LLM batch validation of suspect entries — surfaces findings to admin queue | Deferred until Tier 1 misses enough to justify it |
| **3** | Real-time LLM-in-the-loop with Wine-Searcher comparison | Overkill at current scale |

---

## NoSQL injection guard

`priceWarnings.js` resolvers are reachable from `req.body` (the `wineDefinition`, `vintage`, `currency` fields on the bottle-add request). Every value reaching a Mongo `$match` is sanitised **inline** with `String()` coercion + a `HEX24` regex check for ObjectId fields:

```js
const cur     = String(currency || 'USD').toUpperCase();
const wdStr   = wineDefinitionId == null ? '' : String(wineDefinitionId);
const wdOk    = /^[a-f0-9]{24}$/i.test(wdStr);
// ... only if wdOk does the findOne run
```

An injected operator object like `{ $ne: null }` stringifies to `"[object Object]"` — fails the HEX24 regex (for ObjectIds) or simply doesn't match any document (for currency / vintage strings). CodeQL's `js/sql-injection` analyser recognises the inline `String()` + regex pattern; an earlier refactor that extracted these into a helper hid the sanitiser from the static analysis.

---

## Key Files

| File | Role |
|---|---|
| `frontend/src/utils/importMappers.js` | `parseLocaleNumber`, applied across all 5 import mappers |
| `frontend/src/utils/importMappers.test.js` | Regression tests pinning the parseFloat bugs |
| `backend/src/utils/priceValidation.js` | The four pure sanity rules + their constants |
| `backend/src/utils/priceValidation.test.js` | 20-test suite — each rule + the prod incident |
| `backend/src/services/priceWarnings.js` | DB-backed wrapper: user-median, market-median, NoSQL-injection guards |
| `frontend/src/utils/priceValidation.js` | Frontend mirror of the rules + `describePriceWarning()` for non-i18n contexts |
| `frontend/src/pages/AddBottle.js` | Live warnings under the price input |
| `frontend/src/pages/ImportBottles.js` | ⚠️ per row, summary stat, banner at top |
| `frontend/src/locales/{en,sv}/translation.json` | `addBottle.priceWarning.*` namespace |
