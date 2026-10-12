import { convertRating, formatRating, SCALE_META } from './ratingUtils';

/**
 * Extra details a cellar-list card can show, picked by the user under
 * "Show on cards" (forum feedback 2026-10-12: "choose some of the additional
 * bottle details to display in the main list, for example ratings").
 * Kept per device, like the list's density and notes toggles.
 */
export const CARD_FIELDS = ['rating', 'price', 'size', 'region', 'purchased'];
export const CARD_FIELDS_STORAGE_KEY = 'cellarion_bottle_fields';

export function readCardFields() {
  try {
    const raw = JSON.parse(localStorage.getItem(CARD_FIELDS_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? CARD_FIELDS.filter((f) => raw.includes(f)) : [];
  } catch {
    return [];
  }
}

export function storeCardFields(fields) {
  try { localStorage.setItem(CARD_FIELDS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* private mode */ }
}

const same = (values) => values.every((v) => v === values[0]);

// One value, or the range a stack of bottles spans ("4.0–4.5★", "€40–55").
function ratingText(bottles, scale) {
  const values = bottles
    .map((b) => (b.rating != null && !isNaN(b.rating) ? convertRating(Number(b.rating), b.ratingScale || '5', scale) : null))
    .filter((v) => v != null);
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return formatRating(min, scale);
  const precision = (SCALE_META[scale] || SCALE_META['5']).step < 1 ? 1 : 0;
  return `${min.toFixed(precision)}–${formatRating(max, scale)}`;
}

function priceText(bottles, locale) {
  const priced = bottles.filter((b) => b.price != null && !isNaN(b.price) && b.currency);
  if (priced.length === 0) return '';
  const currency = priced[0].currency;
  if (!priced.every((b) => b.currency === currency)) return '';
  let fmt;
  try {
    fmt = new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    return '';
  }
  const min = Math.min(...priced.map((b) => Number(b.price)));
  const max = Math.max(...priced.map((b) => Number(b.price)));
  return min === max ? fmt.format(min) : `${fmt.format(min)}–${fmt.format(max).replace(/^[^\d]*/, '')}`;
}

function purchasedText(bottles, locale) {
  const dates = bottles.map((b) => (b.purchaseDate ? new Date(b.purchaseDate) : null)).filter((d) => d && !isNaN(d));
  if (dates.length === 0) return '';
  const ms = dates.map((d) => d.getTime());
  const first = new Date(Math.min(...ms));
  const last = new Date(Math.max(...ms));
  const month = (d) => d.toLocaleDateString(locale, { month: 'short', year: 'numeric' });
  if (month(first) === month(last)) return month(first);
  return first.getFullYear() === last.getFullYear() ? String(first.getFullYear()) : `${first.getFullYear()}–${last.getFullYear()}`;
}

/**
 * The chosen details for one list entry — a single bottle or a stack of the
 * same wine, vintage and size — as [{ field, text }], in CARD_FIELDS order,
 * leaving out what the bottles do not have. `showRegion` is false where the
 * card already shows the region (the grid view).
 */
export function cardDetails(bottles, fields, { ratingScale = '5', locale, showRegion = true } = {}) {
  const list = (bottles || []).filter(Boolean);
  if (list.length === 0 || !fields || fields.length === 0) return [];
  const out = [];
  for (const field of CARD_FIELDS) {
    if (!fields.includes(field)) continue;
    let text = '';
    if (field === 'rating') text = ratingText(list, ratingScale);
    else if (field === 'price') text = priceText(list, locale);
    else if (field === 'size') text = list[0].bottleSize || '';
    else if (field === 'region' && showRegion) {
      const names = list.map((b) => b.wineDefinition?.region?.name || b.wineDefinition?.country?.name || '');
      text = names[0] && same(names) ? names[0] : '';
    } else if (field === 'purchased') text = purchasedText(list, locale);
    if (text) out.push({ field, text });
  }
  return out;
}
