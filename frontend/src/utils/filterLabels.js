import { formatRating, fromNormalized } from './ratingUtils';

// The six maturity buckets the bottle-list filter offers, in display order.
// 'none' = no maturity data. Mirrors backend MATURITY_FILTER_VALUES.
export const MATURITY_FILTER_OPTIONS = ['peak', 'early', 'late', 'declining', 'not-ready', 'none'];

// "Needs attention" — the combination almost every owner asks for (support
// ticket 2026-09-12): what should I drink before it fades.
export const NEEDS_ATTENTION = ['late', 'declining'];

// i18n key under maturity.* for each bucket.
export const MATURITY_I18N_KEY = {
  peak: 'maturity.peak', early: 'maturity.early', late: 'maturity.late',
  declining: 'maturity.declining', 'not-ready': 'maturity.notReady', none: 'maturity.noData',
};

// cellar statistics `maturity` bucket name for each filter value.
export const MATURITY_STATS_KEY = {
  peak: 'peak', early: 'early', late: 'late', declining: 'declining',
  'not-ready': 'notReady', none: 'noProfile',
};

/**
 * The maturity filter is an array of buckets (multi-select, OR). Older saved
 * selections (sessionStorage / bookmarked URLs) carry one bucket as a string,
 * and a URL carries several comma-separated — normalise every shape.
 */
export function toMaturityArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value) return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Chip text for a rating range held as NORMALISED bounds (0–100 strings, the
 * wire format) rendered in the user's own scale: "3.5★ and up", "Up to 4.2★",
 * "3.5★ to 4.2★". Returns null when neither bound is set.
 */
export function ratingRangeLabel(t, minNorm, maxNorm, scale) {
  const fmt = (n) => formatRating(fromNormalized(Number(n), scale), scale);
  const hasMin = minNorm !== '' && minNorm != null && !isNaN(Number(minNorm));
  const hasMax = maxNorm !== '' && maxNorm != null && !isNaN(Number(maxNorm));
  if (hasMin && hasMax) return t('cellarDetail.ratingChipRange', '{{min}} to {{max}}', { min: fmt(minNorm), max: fmt(maxNorm) });
  if (hasMin) return t('cellarDetail.ratingChipMin', '{{value}} and up', { value: fmt(minNorm) });
  if (hasMax) return t('cellarDetail.ratingChipMax', 'Up to {{value}}', { value: fmt(maxNorm) });
  return null;
}
