import { convertRating, formatRating, SCALE_META } from './ratingUtils';
import { formatVolume, mlFromCode } from '../config/bottleSizes';

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

// Formatters are costly to build and a list draws hundreds of cards: one per
// locale (and currency), made once (release audit 2026-10-12).
const priceFormats = new Map();
function priceFormat(locale, currency) {
  const key = `${locale}|${currency}`;
  if (!priceFormats.has(key)) {
    let fmt = null;
    try { fmt = new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }); } catch { /* unknown currency code */ }
    priceFormats.set(key, fmt);
  }
  return priceFormats.get(key);
}
// Purchase dates are stored as UTC midnight: read them in UTC, or a March
// purchase shows as February west of Greenwich.
const monthFormats = new Map();
function monthFormat(locale) {
  if (!monthFormats.has(locale)) {
    let fmt;
    try { fmt = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { fmt = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }
    monthFormats.set(locale, fmt);
  }
  return monthFormats.get(locale);
}

// One value, or the range a stack of bottles spans ("4.0–4.5★", "€40–55").
// A stored 0 means unrated (as on the server), never a score. Ends that
// read the same once formatted show once.
function ratingText(bottles, scale) {
  const values = bottles
    .map((b) => (Number(b.rating) > 0 ? convertRating(Number(b.rating), b.ratingScale || '5', scale) : null))
    .filter((v) => v != null);
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (formatRating(min, scale) === formatRating(max, scale)) return formatRating(max, scale);
  const precision = (SCALE_META[scale] || SCALE_META['5']).step < 1 ? 1 : 0;
  return `${min.toFixed(precision)}–${formatRating(max, scale)}`;
}

function priceText(bottles, locale) {
  const priced = bottles.filter((b) => b.price != null && !isNaN(b.price) && b.currency);
  if (priced.length === 0) return '';
  const currency = priced[0].currency;
  if (!priced.every((b) => b.currency === currency)) return '';
  const fmt = priceFormat(locale, currency);
  if (!fmt) return '';
  const lo = fmt.format(Math.min(...priced.map((b) => Number(b.price))));
  const hi = fmt.format(Math.max(...priced.map((b) => Number(b.price))));
  return lo === hi ? lo : `${lo}–${hi.replace(/^[^\d]*/, '')}`;
}

function purchasedText(bottles, locale) {
  const ms = bottles.map((b) => (b.purchaseDate ? new Date(b.purchaseDate).getTime() : NaN)).filter((t) => !isNaN(t));
  if (ms.length === 0) return '';
  const first = new Date(Math.min(...ms));
  const last = new Date(Math.max(...ms));
  const fmt = monthFormat(locale);
  const a = fmt.format(first);
  if (a === fmt.format(last)) return a;
  const y1 = first.getUTCFullYear();
  const y2 = last.getUTCFullYear();
  return y1 === y2 ? String(y1) : `${y1}–${y2}`;
}

/**
 * The chosen details for one list entry — a single bottle or a stack of the
 * same wine, vintage and size — as [{ field, text }], in CARD_FIELDS order,
 * leaving out what the bottles do not have. `cardShowsRegion` is true where
 * the card already shows the wine's region (the grid view): the region is
 * then left out, but a wine with only a country still shows it.
 */
export function cardDetails(bottles, fields, { ratingScale = '5', locale, cardShowsRegion = false } = {}) {
  const list = (bottles || []).filter(Boolean);
  if (list.length === 0 || !fields || fields.length === 0) return [];
  const out = [];
  for (const field of CARD_FIELDS) {
    if (!fields.includes(field)) continue;
    let text = '';
    if (field === 'rating') text = ratingText(list, ratingScale);
    else if (field === 'price') text = priceText(list, locale);
    else if (field === 'size') text = formatVolume(mlFromCode(list[0].bottleSize)) || list[0].bottleSize || '';
    else if (field === 'region') {
      const names = list.map((b) => {
        const region = b.wineDefinition?.region?.name;
        if (region) return cardShowsRegion ? '' : region;
        return b.wineDefinition?.country?.name || '';
      });
      text = names[0] && same(names) ? names[0] : '';
    } else if (field === 'purchased') text = purchasedText(list, locale);
    if (text) out.push({ field, text });
  }
  return out;
}
