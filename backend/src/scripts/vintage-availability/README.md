# Vintage-availability probe (feasibility spike)

Goal: detect when a **new vintage of a wine hits the market**, so we can notify a
user who is waiting for it (e.g. "your latest is 2023 — the 2024 is now on sale").

This folder is a **proof-of-concept probe**, not wired into the app yet. It exists
to answer one question: _can we get a reliable "this vintage is on the market now"
signal from free public sources?_

## How detection works

For a watched wine we periodically (daily/weekly cron) ask each source for the set
of vintages currently **available/buyable**. We store that set per wine and diff it
on the next run — any vintage that is available now but wasn't before is a **new
release** → notify the watchers. The pure diff logic lives in [`detect.js`](detect.js)
and is unit-tested offline in [`detect.test.js`](detect.test.js).

## Sources probed

| Source | Status | Key? | Vintage signal | Availability signal | Coverage |
|--------|--------|------|----------------|---------------------|----------|
| **Vinmonopolet (NO)** | ✅ **works** | none | vintage parsed from product name | `buyable === true` & `status === 'aktiv'` | Norway (full monopoly catalog) |
| **Alko (FI)** | ⏳ see providers/alko.js | none | `Vuosikerta` column | present in current price file | Finland (full monopoly catalog) |
| **LWIN (Liv-ex)** | ⏳ prediction only | form-gated download | vintage-config (Sequential / first / final year) | ❌ none — predicts *expected* next vintage | fine wine identity |

Notes:
- Vinmonopolet has **no dedicated vintage field** in the API; each vintage is a
  separate product and the year is in the product **name** (`"Ch. Margaux 2021"`),
  so we regex it out. Verified live via `/vmpws/v2/vmp/products/search` (no API key).
- LWIN gives **no availability** — it is an identity/prediction aid (compute the
  *expected* next vintage for "sequential" wines), to be cross-checked against the
  availability sources above.
- **Systembolaget (SE) is intentionally excluded**: no public product API and
  scraping is not permitted.

## Usage

```bash
cd backend

# Probe a single wine (optionally check a specific wanted vintage)
node src/scripts/vintage-availability/probe.js "Château Margaux" 2022

# Feasibility go/no-go: runs a fixed panel and exits non-zero if a source is down
node src/scripts/vintage-availability/probe.js --selfcheck

# Offline unit test of the detection logic (part of `npm test`)
npx jest src/scripts/vintage-availability/detect.test.js
```

## Docker / prod impact

- No new services, no new env vars, no schema changes — pure read-only outbound
  HTTP from the existing `backend` container. Safe to run there
  (`docker exec cellarion-backend node src/scripts/vintage-availability/probe.js --selfcheck`).
- If this graduates into a feature, the recurring check would be one more
  `node-cron` job in `src/services/scheduler.js` (single backend container — same
  in-process model as the other jobs; mind the no-distributed-lock caveat if ever
  scaled to >1 replica).
