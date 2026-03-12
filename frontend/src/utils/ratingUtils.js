/**
 * Wine rating scale utilities (frontend mirror of backend/src/utils/ratingUtils.js).
 *
 * Three industry-standard scales:
 *  '5'   — Star Rating       (1–5,    step 0.1)  consumer / everyday
 *  '20'  — Davis 20-Point    (1–20,   step 0.1)  UC Davis / Jancis Robinson / UK wine trade
 *  '100' — Parker 100-Point  (50–100, step 1)    Wine Advocate / Wine Spectator / Decanter
 *
 * Conversion uses piecewise-linear interpolation based on wine-expert consensus
 * anchor points (Wine Advocate descriptors, Jancis Robinson, UC Davis).
 * All scales map to a shared 0–100 normalized range for aggregation.
 */

export const SCALE_META = {
  '5':   { min: 1,  max: 5,   step: 0.1, label: 'Star Rating',      suffix: '★' },
  '20':  { min: 1,  max: 20,  step: 0.1, label: 'Davis 20-Point',   suffix: '/20' },
  '100': { min: 50, max: 100, step: 1,   label: 'Parker 100-Point', suffix: 'pts' },
};

export const VALID_SCALES = Object.keys(SCALE_META);

/**
 * Expert-consensus anchor points mapping quality tiers across scales.
 * Each row: [5-star, 20-point, Parker 100-point, normalized 0–100].
 * Between anchors we interpolate linearly so the "interesting" ranges of
 * each scale align: e.g. Parker 82-100 maps to Stars 3.0-5.0, not 3.6-5.0.
 */
const ANCHORS = [
  // star, davis, parker, normalized
  [1.0,   8.0,   60,     0],
  [2.0,  12.0,   75,    25],
  [3.0,  14.5,   82,    50],
  [3.5,  16.0,   86,    62.5],
  [4.0,  17.5,   91,    75],
  [4.5,  19.0,   96,    87.5],
  [5.0,  20.0,  100,   100],
];

// Column indices into ANCHORS
const COL = { '5': 0, '20': 1, '100': 2, norm: 3 };

/**
 * Piecewise-linear interpolation: given value in column `fromCol`,
 * return the corresponding value in column `toCol`.
 */
function piecewise(value, fromCol, toCol) {
  if (value <= ANCHORS[0][fromCol]) return ANCHORS[0][toCol];
  if (value >= ANCHORS[ANCHORS.length - 1][fromCol]) return ANCHORS[ANCHORS.length - 1][toCol];
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    const lo = ANCHORS[i][fromCol];
    const hi = ANCHORS[i + 1][fromCol];
    if (value >= lo && value <= hi) {
      const t = (value - lo) / (hi - lo);
      return ANCHORS[i][toCol] + t * (ANCHORS[i + 1][toCol] - ANCHORS[i][toCol]);
    }
  }
  return ANCHORS[0][toCol];
}

/**
 * Convert a raw rating value + scale to a 0–100 normalized score.
 * Returns null if value is null/undefined/invalid.
 */
export function toNormalized(value, scale) {
  if (value == null || isNaN(value)) return null;
  const v = Number(value);
  const col = COL[scale];
  if (col == null) return piecewise(v, COL['5'], COL.norm);
  return piecewise(v, col, COL.norm);
}

/**
 * Convert a 0–100 normalized score back to a target scale value.
 * Returns null if normalized is null/undefined/invalid.
 */
export function fromNormalized(normalized, targetScale) {
  if (normalized == null || isNaN(normalized)) return null;
  const n = Number(normalized);
  const col = COL[targetScale];
  const raw = col != null ? piecewise(n, COL.norm, col) : piecewise(n, COL.norm, COL['5']);
  const meta = SCALE_META[targetScale] || SCALE_META['5'];
  const precision = meta.step < 1 ? 10 : 1;
  return Math.round(raw * precision) / precision;
}

/**
 * Convert a rating value directly from one scale to another.
 */
export function convertRating(value, fromScale, toScale) {
  if (value == null || isNaN(value)) return null;
  if (fromScale === toScale) return Number(value);
  return fromNormalized(toNormalized(value, fromScale), toScale);
}

/**
 * Format a rating value as a display string.
 *   formatRating(4.6, '5')  → "4.6★"
 *   formatRating(17.5, '20') → "17.5/20"
 *   formatRating(92, '100')  → "92pts"
 */
export function formatRating(value, scale) {
  if (value == null || isNaN(value)) return '—';
  const meta = SCALE_META[scale] || SCALE_META['5'];
  const v = Number(value);
  const precision = meta.step < 1 ? 1 : 0;
  return `${v.toFixed(precision)}${meta.suffix}`;
}

/**
 * Return a display object with the rating shown in all three scales.
 * Input is the stored raw value + its scale.
 */
export function allScales(value, scale) {
  if (value == null || isNaN(value)) return null;
  const norm = toNormalized(value, scale);
  if (norm == null) return null;

  return {
    star:       formatRating(fromNormalized(norm, '5'),   '5'),
    davis:      formatRating(fromNormalized(norm, '20'),  '20'),
    parker:     formatRating(fromNormalized(norm, '100'), '100'),
    normalized: Math.round(norm * 10) / 10,
  };
}

/**
 * Format a normalized rating delta (difference between two normalized 0-100 scores)
 * in the user's preferred scale.
 *
 * Because the piecewise mapping is non-linear, we convert a delta by mapping
 * two points around the midpoint (50) through the curve and taking their difference.
 */
export function formatDelta(normalizedDelta, scale) {
  if (normalizedDelta == null || isNaN(normalizedDelta)) return '—';
  const n = Number(normalizedDelta);
  const mid = 50;
  const hi = fromNormalized(Math.min(100, mid + Math.abs(n) / 2), scale);
  const lo = fromNormalized(Math.max(0,   mid - Math.abs(n) / 2), scale);
  const raw = (hi - lo) * Math.sign(n);
  const meta = SCALE_META[scale] || SCALE_META['5'];
  const precision = meta.step < 1 ? 10 : 1;
  const rounded = Math.round(raw * precision) / precision;
  return `${rounded.toFixed(meta.step < 1 ? 1 : 0)}${meta.suffix}`;
}

/**
 * Validate that a value is within the allowed range for a given scale.
 */
export function isValidRating(value, scale) {
  if (value == null || isNaN(value)) return false;
  const meta = SCALE_META[scale];
  if (!meta) return false;
  const v = Number(value);
  return v >= meta.min && v <= meta.max;
}
