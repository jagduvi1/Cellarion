/**
 * Wine rating scale utilities (frontend mirror of backend/src/utils/ratingUtils.js).
 *
 * Three industry-standard scales:
 *  '5'   — Star Rating       (1–5,    step 0.1)  consumer / everyday
 *  '20'  — Davis 20-Point    (1–20,   step 0.1)  UC Davis / Jancis Robinson / UK wine trade
 *  '100' — Parker 100-Point  (50–100, step 1)    Wine Advocate / Wine Spectator / Decanter
 *
 * Normalization maps every scale to a 0–100 float for cross-scale aggregation.
 */

export const SCALE_META = {
  '5':   { min: 1,  max: 5,   step: 0.1, label: 'Star Rating',      suffix: '★' },
  '20':  { min: 1,  max: 20,  step: 0.1, label: 'Davis 20-Point',   suffix: '/20' },
  '100': { min: 50, max: 100, step: 1,   label: 'Parker 100-Point', suffix: 'pts' },
};

export const VALID_SCALES = Object.keys(SCALE_META);

/**
 * Convert a raw rating value + scale to a 0–100 normalized score.
 * Returns null if value is null/undefined/invalid.
 */
export function toNormalized(value, scale) {
  if (value == null || isNaN(value)) return null;
  const v = Number(value);
  switch (scale) {
    case '5':   return (v / 5)          * 100;
    case '20':  return (v / 20)         * 100;
    case '100': return ((v - 50) / 50)  * 100;
    default:    return (v / 5)          * 100;
  }
}

/**
 * Convert a 0–100 normalized score back to a target scale value.
 * Returns null if normalized is null/undefined/invalid.
 */
export function fromNormalized(normalized, targetScale) {
  if (normalized == null || isNaN(normalized)) return null;
  const n = Number(normalized);
  let raw;
  switch (targetScale) {
    case '5':   raw = (n / 100) * 5;         break;
    case '20':  raw = (n / 100) * 20;        break;
    case '100': raw = (n / 100) * 50 + 50;   break;
    default:    raw = (n / 100) * 5;         break;
  }
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
 *
 * allScales(4.6, '5')  → { star: '4.6★', davis: '18.4/20', parker: '92pts', normalized: 92 }
 * allScales(92, '100') → { star: '4.6★', davis: '18.4/20', parker: '92pts', normalized: 84 }
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
 * Format a normalized rating delta (difference between two normalized 0-100 scores).
 * Unlike fromNormalized, this does NOT apply the floor offset for the 100-pt scale,
 * since a delta is a difference, not a point on the scale.
 *
 *   formatDelta(20, '5')   → "1.0★"   (+1 star delta)
 *   formatDelta(20, '20')  → "4.0/20" (+4 points delta)
 *   formatDelta(20, '100') → "10pts"  (+10 points delta, not 60pts)
 */
export function formatDelta(normalizedDelta, scale) {
  if (normalizedDelta == null || isNaN(normalizedDelta)) return '—';
  const n = Number(normalizedDelta);
  let raw;
  switch (scale) {
    case '5':   raw = (n / 100) * 5;   break;
    case '20':  raw = (n / 100) * 20;  break;
    case '100': raw = (n / 100) * 50;  break; // no +50 floor offset for deltas
    default:    raw = (n / 100) * 5;   break;
  }
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
