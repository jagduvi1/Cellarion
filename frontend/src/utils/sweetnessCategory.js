/**
 * The sweetness category of a wine, on the screens: dry, off-dry,
 * medium-sweet or sweet — one scale for still and sparkling wines. The server
 * works it out from the wine record and sends it on the wine as
 * `sweetnessCategory` with `sweetnessCategoryBasis` (backend
 * services/sweetnessCategory.js, whose CATEGORIES, NOT_STATED and
 * sweetnessFilterValue these mirror). Nothing is worked out here.
 */

// In scale order, driest first.
export const SWEETNESS_CATEGORIES = ['dry', 'off-dry', 'medium-sweet', 'sweet'];
// A filter value, never a category: the wines that could state one and do not.
export const SWEETNESS_NOT_STATED = 'not-stated';
export const SWEETNESS_FILTER_VALUES = [...SWEETNESS_CATEGORIES, SWEETNESS_NOT_STATED];

/**
 * The category's name. The four are the still-wine bands, so they share their
 * words (`sweetness.band.*`, the member-facing names; the admin screens keep
 * their own under `admin.*`, which no translator of the app is asked for).
 */
export const sweetnessCategoryLabel = (t, category) => t(`sweetness.band.${category}`, category);

/** A filter value's name inside the Sweetness section of the filter. */
export const sweetnessFilterLabel = (t, value) => (value === SWEETNESS_NOT_STATED
  ? t('cellarDetail.sweetnessNotStated', 'Not stated')
  : sweetnessCategoryLabel(t, value));

/** The same on a chip, which stands alone: "Not stated" there says of what. */
export const sweetnessChipLabel = (t, value) => (value === SWEETNESS_NOT_STATED
  ? t('cellarDetail.sweetnessNotStatedChip', 'Sweetness not stated')
  : sweetnessCategoryLabel(t, value));

/**
 * What the filter matches a wine on, for the offline copy: its category;
 * "not-stated" for a wine that could state one and does not; '' — found by no
 * sweetness filter — for a fortified wine, a drink that is not wine, a bottle
 * without a wine, and a wine from a copy saved before the category was sent.
 */
export function sweetnessFilterValueOf(wine) {
  if (!wine || typeof wine !== 'object' || !('sweetnessCategory' in wine)) return '';
  if (wine.nonWine === true || wine.type === 'fortified') return '';
  return wine.sweetnessCategory || SWEETNESS_NOT_STATED;
}

/**
 * The wine of a bottle a write just answered with, carrying the reading the
 * page already holds. A write to a bottle answers with its wine but without
 * the category (only the reads work it out), and it changes nothing on the
 * wine — so while the answer is about the same wine, its reading stays.
 * Another wine (the bottle was moved to one) carries nothing over.
 */
export function keepSweetnessReading(prevWine, nextWine) {
  if (!nextWine || typeof nextWine !== 'object' || 'sweetnessCategory' in nextWine) return nextWine;
  if (!prevWine || typeof prevWine !== 'object' || !('sweetnessCategory' in prevWine)) return nextWine;
  if (!nextWine._id || String(prevWine._id) !== String(nextWine._id)) return nextWine;
  return {
    ...nextWine,
    sweetnessCategory: prevWine.sweetnessCategory,
    sweetnessCategoryBasis: prevWine.sweetnessCategoryBasis ?? null,
  };
}
