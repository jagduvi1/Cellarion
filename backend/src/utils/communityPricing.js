/**
 * Pure helpers for community release-price aggregation.
 *
 * No DB / IO here so the cleaning logic is trivially unit-testable. The
 * `communityPriceJob` service feeds these functions per-owner prices grouped by
 * vintage (within a single currency) and persists the result.
 *
 * Design (see docs/wine-valuation-spec.md):
 *  - One value per distinct OWNER (the job medians a user's own bottles first),
 *    so a user with 12 identical bottles can't dominate.
 *  - Cross-vintage consistency is the cold-start cleaner: ordinary wine is
 *    price-stable across vintages, so a single fat-fingered vintage stands out
 *    against its neighbours and is flagged `suspect` (and not published).
 *  - Confidence tier: >= FIRM_MIN_OWNERS distinct owners → 'firm' (median + IQR
 *    trim); 1–2 owners → 'indicative'. This is a trust label, not a privacy
 *    gate — both are shown to users.
 */

// >= this many distinct owners promotes a vintage from 'indicative' to 'firm'.
const FIRM_MIN_OWNERS = 3;
// A vintage is flagged suspect if its price is > SUSPECT_BAND× or < 1/SUSPECT_BAND×
// the wine's typical price (median across vintages) in the same currency. Wide
// enough to allow real good-vs-poor-vintage swings (~3×) while catching decimal/
// zero typos (e.g. 5600 entered for 560).
const SUSPECT_BAND = 4;

/** Median of a non-empty numeric array. Returns null for empty input. */
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Linear-interpolated quantile (0..1) of an already-sorted array. */
function quantileSorted(sorted, q) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Drop values outside [Q1 - k·IQR, Q3 + k·IQR]. Returns the original array if
 * the trim would empty it (defensive — shouldn't happen for k=1.5).
 */
function trimOutliersIQR(values, k = 1.5) {
  if (!values || values.length < 4) return values || [];
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - k * iqr;
  const upper = q3 + k * iqr;
  const trimmed = sorted.filter((v) => v >= lower && v <= upper);
  return trimmed.length > 0 ? trimmed : sorted;
}

/**
 * Build a wine's release-price curve from per-owner prices grouped by vintage,
 * within a single currency.
 *
 * @param {Array<{vintage: string, ownerPrices: number[]}>} vintages
 *        One entry per vintage; `ownerPrices` is one representative price per
 *        DISTINCT owner (already cleaned of non-positive / above-cap values).
 * @param {object} [opts]
 * @param {number} [opts.firmMinOwners=FIRM_MIN_OWNERS]
 * @param {number} [opts.suspectBand=SUSPECT_BAND]
 * @returns {Array<{vintage, medianPrice, sampleSize, confidence, p25, p75, suspect}>}
 *          One entry per input vintage that had at least one owner. `suspect`
 *          entries should not be published.
 */
function buildReleaseCurve(vintages, opts = {}) {
  const firmMinOwners = opts.firmMinOwners ?? FIRM_MIN_OWNERS;
  const suspectBand = opts.suspectBand ?? SUSPECT_BAND;

  // Reduce each vintage to a representative price (median of its owners).
  const reps = vintages
    .map((v) => ({
      vintage: String(v.vintage),
      ownerPrices: (v.ownerPrices || []).filter((p) => typeof p === 'number' && isFinite(p) && p > 0),
    }))
    .filter((v) => v.ownerPrices.length > 0)
    .map((v) => ({ ...v, rep: median(v.ownerPrices), sampleSize: v.ownerPrices.length }));

  if (reps.length === 0) return [];

  // Wine's typical price across vintages — the cross-vintage reference center.
  // Only meaningful with >= 2 vintages; with one vintage nothing to compare to.
  const center = median(reps.map((r) => r.rep));
  const canCrossCheck = reps.length >= 2 && center > 0;

  return reps.map((r) => {
    const suspect = canCrossCheck && (r.rep > suspectBand * center || r.rep < center / suspectBand);

    let medianPrice = r.rep;
    let p25;
    let p75;
    const confidence = r.sampleSize >= firmMinOwners ? 'firm' : 'indicative';

    if (confidence === 'firm') {
      const trimmed = trimOutliersIQR(r.ownerPrices);
      medianPrice = median(trimmed);
      const sorted = [...r.ownerPrices].sort((a, b) => a - b);
      p25 = quantileSorted(sorted, 0.25);
      p75 = quantileSorted(sorted, 0.75);
    }

    return {
      vintage: r.vintage,
      medianPrice: Math.round(medianPrice * 100) / 100,
      sampleSize: r.sampleSize,
      confidence,
      p25: p25 != null ? Math.round(p25 * 100) / 100 : undefined,
      p75: p75 != null ? Math.round(p75 * 100) / 100 : undefined,
      suspect,
    };
  });
}

module.exports = {
  FIRM_MIN_OWNERS,
  SUSPECT_BAND,
  median,
  quantileSorted,
  trimOutliersIQR,
  buildReleaseCurve,
};
