import { SCALE_META, formatRating } from './ratingUtils';

/**
 * Ratings in the analytics table and the dashboards. The engine answers every
 * rating in one scale per request — stars unless the request names another —
 * so each request passes the viewer's own scale (Settings → rating scale) and
 * the numbers come back the way they rate: 92pts, not 4.6★. A rating filter
 * carries the scale its value was typed in, so a saved view or a pinned widget
 * means the same after a settings change.
 *
 * The keys mirror the engine's rating (normalized) fields in
 * backend services/analytics/fieldCatalogue.js.
 */
export const RATING_FIELD_KEYS = ['rating.current', 'rating.consumed'];

export function isRatingField(key) {
  return RATING_FIELD_KEYS.includes(key);
}

/** The rating field a measure label like 'avg(rating.current)' aggregates, or null. */
export function ratingMeasureField(label) {
  const m = /^(?:avg|min|max|sum)\((.+)\)$/.exec(label || '');
  return m && isRatingField(m[1]) ? m[1] : null;
}

/** The viewer's scale, '5' when unset or unknown. */
export function viewerRatingScale(user) {
  const s = user?.preferences?.ratingScale;
  return SCALE_META[s] ? s : '5';
}

/** ★, /20 or pts. */
export function ratingSuffix(scale) {
  return (SCALE_META[scale] || SCALE_META['5']).suffix;
}

/** A rating value the engine returned in `scale`, as "4.6★", "17.5/20" or "92pts". */
export function formatRatingCell(v, scale) {
  return typeof v === 'number' ? formatRating(v, scale) : v;
}

/** The engine's field label without the "(stars)" its own names carry. */
export function ratingFieldLabel(label) {
  return String(label || '').replace(/\s*\(stars\)\s*$/i, '');
}
