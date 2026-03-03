/**
 * Wine rating scale utilities.
 *
 * Three industry-standard scales are supported:
 *  '5'   — Star Rating       (1–5,   step 0.1)  consumer / everyday
 *  '20'  — Davis 20-Point    (1–20,  step 0.1)  UC Davis / Jancis Robinson / UK wine trade
 *  '100' — Parker 100-Point  (50–100, step 1)   Wine Advocate / Wine Spectator / Decanter
 *
 * Normalization maps every scale to a 0–100 float for cross-scale aggregation:
 *   5-star:  normalized = (value / 5)           * 100
 *   20-pt:   normalized = (value / 20)          * 100
 *   100-pt:  normalized = ((value - 50) / 50)   * 100   (floor = 50)
 */

const SCALE_META = {
  '5':   { min: 1,  max: 5,   step: 0.1, label: 'Star Rating',      suffix: '★' },
  '20':  { min: 1,  max: 20,  step: 0.1, label: 'Davis 20-Point',   suffix: '/20' },
  '100': { min: 50, max: 100, step: 1,   label: 'Parker 100-Point', suffix: 'pts' },
};

const VALID_SCALES = Object.keys(SCALE_META);

/**
 * Convert a raw rating value + scale to a 0–100 normalized score.
 * Returns null if value is null/undefined/invalid.
 */
function toNormalized(value, scale) {
  if (value == null || isNaN(value)) return null;
  const v = Number(value);
  switch (scale) {
    case '5':   return (v / 5)          * 100;
    case '20':  return (v / 20)         * 100;
    case '100': return ((v - 50) / 50)  * 100;
    default:    return (v / 5)          * 100; // treat unknown as 5-star
  }
}

/**
 * Convert a 0–100 normalized score back to a target scale value.
 * Returns null if normalized is null/undefined/invalid.
 */
function fromNormalized(normalized, targetScale) {
  if (normalized == null || isNaN(normalized)) return null;
  const n = Number(normalized);
  let raw;
  switch (targetScale) {
    case '5':   raw = (n / 100) * 5;           break;
    case '20':  raw = (n / 100) * 20;          break;
    case '100': raw = (n / 100) * 50 + 50;     break;
    default:    raw = (n / 100) * 5;           break;
  }
  const meta = SCALE_META[targetScale] || SCALE_META['5'];
  // Round to 1 decimal for 5 and 20; whole number for 100
  const precision = meta.step < 1 ? 10 : 1;
  return Math.round(raw * precision) / precision;
}

/**
 * Convert a rating value directly from one scale to another.
 * Returns null if value is null/undefined/invalid.
 */
function convertRating(value, fromScale, toScale) {
  if (value == null || isNaN(value)) return null;
  if (fromScale === toScale) return Number(value);
  return fromNormalized(toNormalized(value, fromScale), toScale);
}

/**
 * Validate that a value is within the allowed range for a given scale.
 * Returns true if valid, false otherwise.
 */
function isValidRating(value, scale) {
  if (value == null || isNaN(value)) return false;
  const meta = SCALE_META[scale];
  if (!meta) return false;
  const v = Number(value);
  return v >= meta.min && v <= meta.max;
}

module.exports = { SCALE_META, VALID_SCALES, toNormalized, fromNormalized, convertRating, isValidRating };
