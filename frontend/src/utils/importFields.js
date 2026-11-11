// Field helpers shared by the import mappers (utils/importMappers.js):
// numbers and prices as people write them, header matching, the rack fields,
// the wine colour, the vintage and dates. No file format owns these, so they
// live apart from the mappers.

/**
 * Robust locale-aware number parser. Handles:
 *   "1234.56"   → 1234.56   (US plain)
 *   "1234,56"   → 1234.56   (EU plain)
 *   "1,234.56"  → 1234.56   (US with thousands separator)
 *   "1.234,56"  → 1234.56   (EU with thousands separator)
 *   "1 234,56"  → 1234.56   (Swedish with space)
 *   "$25.00"    → 25        (currency symbol stripped)
 *   "€25,00"    → 25
 *   "25 kr"    → 25         (trailing currency word stripped)
 *   "0,75"      → 0.75      (EU bottle-size decimal)
 *   "260,00"    → 260       (EU price)
 *
 * Ambiguous edge case: a single comma followed by exactly 3 digits
 * ("1,234") is treated as a US thousands separator → 1234. A real EU
 * decimal almost never has 3 fractional digits in wine pricing, and
 * Vivino/CellarTracker CSV exports use this format heavily.
 *
 * Returns NaN for empty / unparseable input — drop-in safe replacement
 * for parseFloat on any caller that already handles NaN.
 */
// Currencies written in front of a price: ISO codes and the usual short
// forms (Fr. / SFr. for Swiss francs, kr for the Nordic crowns).
const LEADING_CURRENCY = /^(?:usd|eur|gbp|sek|nok|dkk|isk|chf|aud|nzd|cad|jpy|hkd|sgd|zar|cny|inr|brl|mxn|pln|czk|huf|sfr\.?|fr\.?|kr\.?)\s*(?=[+-]?[\d.,])/i;

export function parseLocaleNumber(input) {
  if (input == null) return NaN;
  let s = String(input).trim();
  if (!s) return NaN;

  // Strip currency symbols and surrounding whitespace
  s = s.replace(/[$€£¥¢฿₹₽₺]/g, '');
  // A currency written BEFORE the number ("AUD 45.00", "SEK 199", "Fr. 30") —
  // only a known currency, so "WS 95" (a critic score) or "Lot 12" stays text.
  s = s.replace(LEADING_CURRENCY, '');
  // Swiss thousands: "1'200.00", "1’250".
  s = s.replace(/(\d)['’](?=\d)/g, '$1');
  // Strip trailing currency words (kr, USD, EUR, etc.) and leading sign words
  s = s.replace(/^[+-]?\s*/, m => m.replace(/\s+/g, ''));
  s = s.replace(/\s*[a-zA-Z]+\s*$/, '');
  // Collapse internal whitespace (common in Swedish thousands: "1 234,56")
  s = s.replace(/\s+/g, '');
  if (!s || s === '-' || s === '+') return NaN;

  const hasComma  = s.includes(',');
  const hasPeriod = s.includes('.');

  if (hasComma && hasPeriod) {
    // Both separators present — the LAST one is the decimal.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // EU: "1.234.567,89" → strip periods, swap comma
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: "1,234,567.89" → strip commas
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length > 2) {
      // Multiple commas = thousands separators (US: "1,234,567")
      s = s.replace(/,/g, '');
    } else if (parts[1].length === 3 && parts[0].length >= 1 && parts[0] !== '0') {
      // "1,234" or "12,345" — exactly 3 digits after comma AND integer part
      // > 0 → US thousands. Wine prices in EU rarely have 3 decimal places,
      // and Vivino/CT exports use this format extensively for unquoted
      // numbers. "0,375" with leading zero is treated as EU decimal because
      // it's almost certainly a bottle size in litres (375ml).
      s = s.replace(/,/g, '');
    } else {
      // 1 or 2 digits after, or ≥4 digits → EU decimal
      s = s.replace(',', '.');
    }
  } else if (hasPeriod) {
    const parts = s.split('.');
    if (parts.length > 2) {
      // Multiple periods = EU thousands ("1.234.567"). Drop them all.
      s = s.replace(/\./g, '');
    }
    // Single period = US decimal — parseFloat handles it.
  }

  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

/**
 * A header as a person may have typed it, reduced to one form: case, spaces
 * at either end, and runs of spaces, "_", "-" or "." between words do not
 * matter ("Purchase_Price", " PRICE ", "purchase-price" → "purchase price").
 */
export function normHeader(header) {
  return String(header).replace(/^﻿/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // "PurchasePrice" → "Purchase Price"
    .toLowerCase().replace(/[\s_.-]+/g, ' ').trim();
}

/**
 * Build a header-tolerant accessor over a parsed CSV row: get(keys) returns
 * the first non-empty value among the given header names, trimmed — or ''
 * when none match. Each name is tried as written, lowercased, and then in its
 * normHeader form against the row's headers in theirs (forum feedback
 * 2026-10-12: a price column that was not spelled exactly "Price" was
 * dropped without a word).
 */
export function makeGetter(row) {
  let normalized = null; // header form → value, built on first use
  const loose = (k) => {
    if (!normalized) {
      normalized = new Map();
      for (const [header, value] of Object.entries(row)) {
        const key = normHeader(header);
        if (value && String(value).trim() && !normalized.has(key)) normalized.set(key, String(value));
      }
    }
    return normalized.get(normHeader(k));
  };
  // Name by name, in the caller's order of preference: an earlier name
  // written loosely ("purchase_date") beats a later one written exactly
  // ("date") — the order is the priority (release audit 2026-10-12).
  return (keys) => {
    for (const k of keys) {
      const val = row[k] || row[k.toLowerCase()] || loose(k);
      if (val) return val.trim();
    }
    return '';
  };
}

// The names a purchase-price column goes by in files people write by hand or
// export from other apps, matched in normHeader form. "Value" is left out on
// purpose: in a hand-made file it is a valuation, not what was paid.
// Most specific first: the first column whose value reads as a number wins,
// so a per-bottle price beats a bare "Cost" (often per case). A bare "Paid"
// is left out — it is as often a yes/no or 0/1 column as a price.
export const PRICE_HEADERS = [
  'Price per Bottle', 'Price/Bottle', 'Bottle Price', 'Unit Price', 'Purchase Price',
  'Price Paid', 'Buy Price', 'Price', 'Cost per Bottle', 'Unit Cost', 'Purchase Cost',
  'Pris', 'Inköpspris', 'Prix', "Prix d'achat", 'Preis', 'Kaufpreis', 'Einkaufspreis',
  'Prezzo', 'Precio', 'Prijs', 'Hinta', 'Cost',
];

const PRICE_HEADER_SET = new Set(PRICE_HEADERS.map(normHeader));

// The first price column whose value reads as a number — "Paid" is the price
// in one file and a yes/no column in the next, and must not hide a real one.
export function firstPrice(get) {
  for (const k of PRICE_HEADERS) {
    const text = get([k]);
    if (text && !looksLikeDate(text) && !isNaN(parseLocaleNumber(text))) return text;
  }
  return '';
}

// "2021-09-12", "12/09/2021", "12.09.21" — a date read as a number would be a
// price of 2021 or 12.
function looksLikeDate(text) {
  return /^\d{4}-\d{1,2}-\d{1,2}/.test(text) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(text.trim());
}

// Currency marks a price header may carry. "$" and "kr" are each used by
// several currencies, so they are recognised as a currency mark but do not
// set one.
const HEADER_CURRENCY_SYMBOLS = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '$': null, 'kr': null };

const HEADER_CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'HKD', 'SGD', 'ZAR',
]);

/**
 * A price column that names its currency in the header: "Price (AUD)",
 * "Price [EUR]", "Price in GBP", "Cost €", "Pris kr". Returns the header's
 * value and the currency it names ({ value, currency }), or null. A currency
 * mark shared by several currencies ($, kr) gives currency undefined.
 */
export function priceFromCurrencyHeader(row) {
  for (const [header, value] of Object.entries(row || {})) {
    if (!value || !String(value).trim()) continue;
    const m = /^(.*?)\s*(?:[([]\s*(?:in\s+)?([^)\]]+?)\s*[)\]]|\s(?:in\s+)?([A-Za-z]{3}|kr)|\s*([€£¥$]))\s*$/i.exec(String(header).replace(/^﻿/, '').trim());
    if (!m || !PRICE_HEADER_SET.has(normHeader(m[1]))) continue;
    const mark = (m[2] || m[3] || m[4] || '').trim();
    const code = mark.toUpperCase();
    let currency;
    if (HEADER_CURRENCY_CODES.has(code)) currency = code;
    else if (Object.prototype.hasOwnProperty.call(HEADER_CURRENCY_SYMBOLS, mark.toLowerCase())) currency = HEADER_CURRENCY_SYMBOLS[mark.toLowerCase()] || undefined;
    else continue; // "(per case)", "(incl. tax)" — not a currency mark
    return { value: String(value).trim(), currency };
  }
  return null;
}

// A header that reads like a price column, in any of the languages above —
// for the "prices were not read" warning, not for reading values.
const PRICE_LIKE_HEADER = /\b(price|prices|cost|pris|prix|preis|prezzo|precio|prijs|hinta|paid|kostnad|inköpspris|kaufpreis|einkaufspreis)\b/;

// A valuation is not what was paid: "Market price", "Value", "Estimate".
const VALUATION_HEADER = /\b(market|value|valuation|estimate|estimated|auction|retail)\b/;

export function looksLikePriceHeader(header) {
  const h = normHeader(header);
  return PRICE_LIKE_HEADER.test(h) && !VALUATION_HEADER.test(h);
}

/**
 * Infer a rating scale from the rating's magnitude: >20 → 100-point,
 * >5 → 20-point, otherwise (including NaN) 5-point.
 */
export function inferRatingScale(rating) {
  return rating > 20 ? '100' : rating > 5 ? '20' : '5';
}

/**
 * Rack-mapping fields shared by the Vivino/CellarTracker/generic mappers,
 * returned as an object to spread into the mapped row. The generic mapper
 * additionally overrides rackName/rackPosition from combined
 * "Rack_Location"-style columns when present.
 */
export function mapRackFields(get) {
  return {
    rackName: get(['Rack', 'rack', 'Rack Name', 'rackName']) || undefined,
    rackPosition: parseInt(get(['Rack Position', 'rackPosition', 'Position', 'Slot']), 10) || undefined,
    row: parseInt(get(['Row', 'row', 'Bin Row', 'BinRow', 'Rack Row']), 10) || undefined,
    col: parseInt(get(['Col', 'col', 'Column', 'column', 'Bin Col', 'BinCol', 'Rack Col']), 10) || undefined,
    rackRows: parseInt(get(['Rack Rows', 'RackRows', 'rackRows', 'Rack Height']), 10) || undefined,
    rackCols: parseInt(get(['Rack Cols', 'RackCols', 'rackCols', 'Rack Columns', 'Rack Width']), 10) || undefined,
    rackType: get(['Rack Type', 'RackType', 'rackType']) || undefined,
  };
}

// Values that mean "not a wine at all" — CellarTracker tracks spirits
// alongside wine (Category "Distilled", Type "Spirits"). They must never be
// coerced into a wine colour: a whisky called `fortified` is a claim, and a
// whisky called `red` is a worse one.
const NON_WINE_HINTS = ['spirit', 'whisky', 'whiskey', 'distilled', 'liqueur', 'gin', 'rum', 'vodka', 'brandy', 'cognac', 'armagnac'];

export function looksNonWine(...values) {
  const t = values.filter(Boolean).join(' ').toLowerCase();
  return NON_WINE_HINTS.some((h) => t.includes(h));
}

// Returns a wine colour, or NULL when the input does not state one.
//
// ⚠️ Unknown is null, never a guess, for an empty value and an unrecognised
// one alike: the parsed type is forwarded with the row, so a guessed 'red'
// would become a stored fact. The AI or a curator fills an unknown colour
// honestly.
export function mapWineType(typeStr) {
  if (!typeStr) return null;
  const t = typeStr.toLowerCase().trim();
  if (looksNonWine(t)) return null;
  if (t.includes('rosé') || t.includes('rose')) return 'rosé';
  if (t.includes('sparkling') || t.includes('champagne') || t.includes('cava') || t.includes('prosecco')) return 'sparkling';
  if (t.includes('dessert') || t.includes('sweet') || t.includes('ice wine')) return 'dessert';
  if (t.includes('fortified') || t.includes('port') || t.includes('sherry') || t.includes('madeira')) return 'fortified';
  // Colour last: "White - Sweet/Dessert" and "White - Sparkling" are CT Type
  // strings whose STYLE is the useful half, so the style tests run first.
  if (t.includes('white')) return 'white';
  if (t.includes('red')) return 'red';
  return null;
}

// A missing vintage is filed as NV — but flagged, so the review can say so and
// let the importer type the year. A silent NV would quietly turn a file of
// vintage-dated bottles into non-vintage ones.
// "N.V." / "n.v." / "NV." (Oeno writes "N.V.") is a STATED non-vintage, not a
// missing one — and the backend's vintage gate accepts only the bare "NV".
//
// CellarTracker's sentinels are read here too, not only in the CellarTracker
// mapper's ctVintage: a CT file whose columns no CT fingerprint recognises (a
// "My Cellar" view export with just Wine / Vintage / Size) is parsed by the
// GENERIC mapper, and a "1001" sent on would be refused by the backend, which
// takes no year below 1900: the bottle would be dropped. No wine has those
// years, so they are sentinels whichever mapper claimed the file: 1001 is a
// stated non-vintage, 9999 an unknown year (filed like a blank one).
const NV_RE = /^n\.?\s?v\.?$/i;

export function vintageOrNV(raw) {
  const v = String(raw || '').trim();
  if (!v || v === '9999') return { vintage: 'NV', vintageMissing: true };
  if (NV_RE.test(v) || v === '1001') return { vintage: 'NV' };
  return { vintage: v };
}

export function tryParseDate(str) {
  if (!str) return undefined;
  // Handle year-only values (e.g., "2025" -> "2025-01-01")
  if (/^\d{4}$/.test(str.trim())) {
    return `${str.trim()}-01-01`;
  }
  // Already ISO (date-only or full timestamp): keep the calendar date as-is.
  // Date-only ISO strings parse as UTC midnight, so round-tripping them
  // through Date would shift the day for users west of UTC.
  const iso = String(str).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  if (iso) return iso[1];
  const d = new Date(str);
  if (isNaN(d.getTime())) return undefined;
  // Format from LOCAL date parts. Non-ISO strings ("10/30/2024") parse as
  // local midnight, so rendering via toISOString() (UTC) would shift the
  // date by a day for any user east of UTC.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
