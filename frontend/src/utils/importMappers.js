/**
 * Bottle Import Pre-Mappers
 *
 * Converts CSV/JSON exports from various wine tracking systems into
 * the Cellarion master import format.
 *
 * Master format (per item):
 *   wineName      - Wine name (required)
 *   producer      - Producer/winery name (required)
 *   vintage       - Vintage year or 'NV'
 *   country       - Country name
 *   region        - Region name
 *   appellation   - Appellation / sub-region
 *   type          - red | white | rosé | sparkling | dessert | fortified
 *   price         - Purchase price (number)
 *   currency      - ISO 4217 currency code
 *   bottleSize    - e.g. '750ml', '1.5L'
 *   quantity      - Number of bottles (expanded into individual items)
 *   purchaseDate  - ISO date string
 *   purchaseLocation - Where purchased
 *   notes         - Tasting notes / comments
 *   rating        - Numeric rating
 *   ratingScale   - '5' | '20' | '100'
 *   location      - Physical location in cellar
 *   rackName      - Name of rack to place into (auto-created if missing)
 *   rackPosition  - 1-indexed slot number (used directly if provided)
 *   row, col      - Alternative to rackPosition: row and column in the rack.
 *                   The importer flattens (row, col) → position using the
 *                   rack's geometry and the user-selected rowOrigin.
 *   rackRows, rackCols - Rack dimensions (used when auto-creating racks
 *                   and for row-origin math). Optional — also inferred from
 *                   max observed (row, col) per rack.
 *   rackType      - Optional rack type (grid|shelf|hex|triangle|stack|x-rack|cube)
 *
 * CellarTracker imports additionally emit (consumed by the backend importer):
 *   grapes        - [string] grape varieties (from Varietal/MasterVarietal)
 *   drinkFrom     - integer drink-window start year, or null
 *   drinkTo       - integer drink-window end year, or null
 * Vivino imports also emit drinkFrom/drinkTo (from "Drinking Window") plus a
 * transient `scanDate` that the import UI turns into consumedAt for
 * scan-history files (see isVivinoScanHistory) and strips otherwise.
 * …and, when a CT Location's bin codes follow a consistent pattern, the rack
 * fields above are auto-derived per bottle (see applyCtRackAutoMap +
 * binCodeParser.js). The freeform `location` string is always kept as well.
 */

import { normalizeBottleSize } from '../config/bottleSizes';
import { analyzeBinGroups } from './binCodeParser';

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
export function parseLocaleNumber(input) {
  if (input == null) return NaN;
  let s = String(input).trim();
  if (!s) return NaN;

  // Strip currency symbols and surrounding whitespace
  s = s.replace(/[$€£¥¢฿₹₽₺]/g, '');
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
 * Parse CSV text into an array of row objects.
 * Handles quoted fields, embedded commas, and newlines within quotes.
 * Production callers should pre-detect the delimiter via detectDelimiter()
 * before calling this (see parseAndMap below).
 */
export function parseCSV(text, delimiter = ',') {
  // A double-quote is only STRUCTURAL when it sits at a field boundary: an
  // opening quote immediately follows a delimiter or line-start; a closing
  // quote is immediately followed by a delimiter, line-end, or a doubled quote
  // (the RFC 4180 escape). A quote anywhere else — e.g. an inch mark in a
  // tasting note (Poured a 2" taste) — is a LITERAL character and must NOT
  // toggle quote state. The old code toggled on every quote, so a single
  // stray quote left the parser "in quotes" across the row-terminating newline
  // and swallowed every following row into one merged line.
  const isBoundary = (c) => c === undefined || c === delimiter || c === '\n' || c === '\r';

  const lines = [];
  let current = '';
  let inQuotes = false;

  // Pass 1: split into logical lines. Newlines inside a properly-quoted field
  // are kept as content; quote characters are preserved for pass 2 to re-parse.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes) {
        if (text[i + 1] === '"') {
          current += '""';
          i++; // keep the escaped pair intact for splitLine
        } else if (isBoundary(text[i + 1])) {
          inQuotes = false; // closing quote
          current += '"';
        } else {
          current += '"'; // stray quote inside the field — literal, stay open
        }
      } else if (current === '' || current[current.length - 1] === delimiter) {
        inQuotes = true; // opening quote at field start
        current += '"';
      } else {
        current += '"'; // stray quote mid-field — literal, stay unquoted
      }
    } else if (ch === '\n' && !inQuotes) {
      if (current.trim() || lines.length > 0) lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip CR, handle in \n
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  // Pass 2: split one logical line into fields, honoring quotes with the same
  // boundary rule so an unbalanced quote can't eat the delimiters after it.
  const splitLine = (line) => {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ) {
          if (line[i + 1] === '"') {
            field += '"';
            i++;
          } else if (line[i + 1] === undefined || line[i + 1] === delimiter) {
            inQ = false; // closing quote
          } else {
            field += '"'; // stray quote inside the field — literal
          }
        } else if (field === '') {
          inQ = true; // opening quote at field start
        } else {
          field += '"'; // stray quote mid-field — literal
        }
      } else if (c === delimiter && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = splitLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    if (values.every(v => !v)) continue; // skip empty rows
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Detect the source format from CSV headers.
 * Returns: 'cellarion' | 'vivino' | 'cellartracker' | 'oeno-export' | 'generic'
 *
 * Note: real Oeno-by-Vintec exports use a two-section CSV (cabinet defs +
 * bottles) detected by `detectOenoExport` against the raw text, not by
 * single-row headers. This function only sees the headers of section 2 (or
 * a single-section file), so Oeno-export detection happens at parse time.
 */
export function detectFormat(headers) {
  const h = new Set(headers.map(s => s.toLowerCase().trim()));
  const raw = new Set(headers.map(s => s.trim()));

  // Cellarion's own CSV export uses camelCase headers
  if (raw.has('wineName') && raw.has('producer') && raw.has('vintage')) return 'cellarion';

  // Vivino export headers
  if (h.has('wine name') || h.has('winery')) return 'vivino';

  // CellarTracker export headers
  if (h.has('iwine') || h.has('barcode') || h.has('cellartracker')) return 'cellartracker';
  if (h.has('wine') && h.has('vintage') && (h.has('locale') || h.has('bin'))) return 'cellartracker';

  return 'generic';
}

/**
 * Detect Oeno-by-Vintec's real two-section export by scanning for the
 * "User Bottles Details" marker separating the cabinet definitions from
 * the bottle records. Returns the row index of the bottle-section header
 * row, or -1 if the file isn't an Oeno export.
 */
export function detectOenoExportBoundary(rows) {
  for (let i = 0; i < rows.length; i++) {
    const firstCell = (rows[i].split(',')[0] || '').trim();
    if (firstCell === 'Bottle ID') return i;
  }
  return -1;
}

/**
 * Parse a combined rack-location string like "M2-11" or "Cabinet 1-15" into
 * a rack name + 1-indexed position. Splits on the LAST hyphen so rack names
 * containing hyphens still work. Returns null when the right side isn't a
 * positive integer.
 */
export function parseCombinedRackLocation(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const lastDash = trimmed.lastIndexOf('-');
  if (lastDash < 1 || lastDash === trimmed.length - 1) return null;
  const left = trimmed.slice(0, lastDash).trim();
  const right = trimmed.slice(lastDash + 1).trim();
  if (!left) return null;
  // Right side must be a pure positive integer (allow leading zeros: "04")
  if (!/^\d+$/.test(right)) return null;
  const pos = parseInt(right, 10);
  if (pos < 1) return null;
  return { rackName: left, rackPosition: pos };
}

/**
 * Suggest reasonable rack dimensions given a max position observed in import
 * data. Mirrors the backend helper of the same name. Biases toward common
 * physical wine-rack widths (6 or 12 columns).
 */
export function suggestRackDimensions(maxPosition) {
  const p = Math.max(1, parseInt(maxPosition, 10) || 1);
  if (p <= 6)  return { rows: 1, cols: p };
  if (p <= 12) return { rows: 2, cols: 6 };
  if (p <= 24) return { rows: 4, cols: 6 };
  if (p <= 72) return { rows: 6, cols: 12 };
  const cols = 12;
  const rows = Math.min(20, Math.ceil(p / cols));
  return { rows, cols };
}

/**
 * Summarise rack usage in a parsed-items batch:
 *   { [rackName]: { count, maxPosition, maxPerCell, observedPositions: number[] } }
 *
 * `maxPerCell` tracks the highest number of items sharing the same
 * rackPosition within a single rack — for Oeno-format imports this is the
 * "max bottles on the busiest shelf" stat shown in the picker's meta line.
 * Always returned for diagnostics; the rack-default chooser
 * (`getDefaultRackConfig`) decides what to do with it per format.
 */
export function summariseRacks(items) {
  const summary = {};
  const positionCounts = {}; // { [rackName]: { [position]: count } }
  for (const item of items) {
    if (!item?.rackName) continue;
    const name = String(item.rackName).trim();
    if (!name) continue;
    if (!summary[name]) summary[name] = { count: 0, maxPosition: 0, maxPerCell: 1, observedPositions: [] };
    summary[name].count += 1;
    const pos = parseInt(item.rackPosition, 10);
    if (!isNaN(pos)) {
      summary[name].observedPositions.push(pos);
      if (pos > summary[name].maxPosition) summary[name].maxPosition = pos;
      if (!positionCounts[name]) positionCounts[name] = {};
      positionCounts[name][pos] = (positionCounts[name][pos] || 0) + 1;
      if (positionCounts[name][pos] > summary[name].maxPerCell) {
        summary[name].maxPerCell = positionCounts[name][pos];
      }
    }
  }
  return summary;
}

/**
 * Normalise a bottle-size value. Accepts strings like "750ml", "1.5L", or a
 * bare number ("750" / 750) which is treated as millilitres.
 */
function normaliseBottleSize(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return `${s}ml`;
  return s;
}

/**
 * Decode a raw import file (ArrayBuffer/Uint8Array) into text with encoding
 * detection. CellarTracker's browser-UI export is Windows-1252 — reading it
 * as UTF-8 silently corrupts every accented producer (Pétrus → P�trus).
 *
 * Order: BOM sniff (UTF-8 / UTF-16LE / UTF-16BE) → strict UTF-8 validation
 * (fatal decoder) → Windows-1252 fallback. cp1252 is used rather than plain
 * latin-1 because it maps the 0x80–0x9F range (curly quotes, €) correctly,
 * and a cp1252 decode never throws — every byte sequence is valid.
 * Valid UTF-8 input always decodes as UTF-8, so this changes nothing for
 * well-formed files.
 *
 * @returns {{ text: string, encoding: 'utf-8'|'utf-16le'|'utf-16be'|'windows-1252' }}
 */
export function decodeImportBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/**
 * CellarTracker's WebQuery endpoint returns an HTML page ("You are currently
 * not logged into CellarTracker.") instead of data when the session is
 * invalid. Fail fast with a recognisable error code instead of parsing HTML
 * as a wine list.
 */
function throwIfHtmlErrorPage(text) {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  const isHtml = head.startsWith('<html') || head.startsWith('<!doctype');
  if (isHtml || text.includes('You are currently not logged into CellarTracker')) {
    const err = new Error('This file is an HTML error page, not a wine export');
    err.code = 'ct-error-page';
    throw err;
  }
}

/**
 * Auto-detect delimiter from first line of CSV.
 */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0];
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes(';')) return ';';
  return ',';
}

// ── Shared row-mapper helpers ───────────────────────────────────────────────

/**
 * Build a header-tolerant accessor over a parsed CSV row: get(keys) returns
 * the first non-empty value among the given header names (each also tried
 * lowercased), trimmed — or '' when none match.
 */
function makeGetter(row) {
  return (keys) => {
    for (const k of keys) {
      const val = row[k] || row[k.toLowerCase()];
      if (val) return val.trim();
    }
    return '';
  };
}

/**
 * Infer a rating scale from the rating's magnitude: >20 → 100-point,
 * >5 → 20-point, otherwise (including NaN) 5-point.
 */
function inferRatingScale(rating) {
  return rating > 20 ? '100' : rating > 5 ? '20' : '5';
}

/**
 * Rack-mapping fields shared by the Vivino/CellarTracker/generic mappers,
 * returned as an object to spread into the mapped row. The generic mapper
 * additionally overrides rackName/rackPosition from combined
 * "Rack_Location"-style columns when present.
 */
function mapRackFields(get) {
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

// ── Vivino Mapper ───────────────────────────────────────────────────────────
//
// Vivino has TWO CSV exports with different meanings:
//
//   A. Cellar export — the user's current inventory. Carries Quantity /
//      Purchase date / Price columns. Rows are bottles they own.
//   B. "Full wine list" (app settings → download your data) — the user's
//      SCAN HISTORY: one row per wine ever scanned or reviewed, with a
//      "Scan date" column and no quantity or purchase data. Rows are mostly
//      wines the user drank, not bottles in the cellar.
//
// Both share the same column vocabulary, so one mapper handles them; the
// history file is fingerprinted by isVivinoScanHistory() below and the
// import UI lets the user choose whether its rows become drinking history
// (default) or active bottles.
//
// Vivino's "Average rating" is the community score and is never imported —
// same policy as CellarTracker's `CT` column. Only "Your rating" is.

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
// ⚠️ It used to return 'red' for both an empty value and an unrecognised one —
// the 15th instance of the colour-guessing class fixed across the app in
// v1.140 (prompts made nullable, 14 client `|| 'red'` fallbacks removed). It
// was harmless only because the parsed type was dropped at the payload
// boundary and never reached a wine; now that type IS forwarded, a guess here
// would become a stored fact. Unknown is null, and the AI or a curator fills
// it honestly.
function mapWineType(typeStr) {
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

/**
 * Vivino "Drinking Window" is two space-separated years ("2026 2034").
 * Tolerates a dash separator ("2026 - 2034"). Returns { drinkFrom, drinkTo }
 * as integers, or nulls when the value doesn't contain a usable pair —
 * matching the CT mappers' null convention for "no window".
 */
export function parseVivinoDrinkWindow(value) {
  const years = (value || '').match(/\b(19|20)\d{2}\b/g);
  if (!years || years.length < 2) return { drinkFrom: null, drinkTo: null };
  const from = parseInt(years[0], 10);
  const to = parseInt(years[years.length - 1], 10);
  if (from > to) return { drinkFrom: null, drinkTo: null };
  return { drinkFrom: from, drinkTo: to };
}

/**
 * Fingerprint Vivino's "full wine list" (scan history) export: it has a
 * "Scan date" column and none of the inventory columns (Quantity / Purchase
 * date) a cellar export carries. parseAndMap surfaces this as
 * `vivinoScanHistory: true` so the import UI can offer the history-vs-cellar
 * destination choice instead of silently inflating the cellar with every
 * wine the user ever scanned.
 */
export function isVivinoScanHistory(headers) {
  const h = new Set(headers.map((s) => s.toLowerCase().trim()));
  return h.has('scan date') && !h.has('quantity') && !h.has('purchase date');
}

function mapVivinoRow(row) {
  // Vivino CSV columns vary but common ones:
  // "Wine name", "Winery", "Vintage", "Country", "Region", "Appellation",
  // "Wine type", "Price", "Currency", "Rating", "Note", "Quantity",
  // "Purchase date", "Store name", "Bottle size"
  // The "full wine list" export adds: "Average rating" (community — never
  // imported), "Scan date", "Your rating", "Your review", "Personal Note",
  // "Drinking Window", "Link to wine", "Label image".
  const get = makeGetter(row);

  const rating = parseLocaleNumber(get(['Your rating', 'Rating', 'My Rating', 'rating']));
  const price = parseLocaleNumber(get(['Price', 'price', 'Purchase Price']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'Count']), 10);
  const { drinkFrom, drinkTo } = parseVivinoDrinkWindow(get(['Drinking Window', 'Drinking window']));

  // "Your review" is the published review text, "Personal Note" the private
  // note — both are the user's own words, so carry both (joined) into notes.
  const notes = [
    get(['Your review', 'Note', 'Notes', 'note', 'notes', 'Tasting Note', 'Review']),
    get(['Personal Note', 'Personal note']),
  ].filter(Boolean).join('\n');

  return {
    wineName: get(['Wine name', 'Wine Name', 'wine name', 'Wine', 'wine']),
    producer: get(['Winery', 'winery', 'Producer', 'producer']),
    vintage: get(['Vintage', 'vintage', 'Year', 'year']) || 'NV',
    country: get(['Country', 'country']),
    region: get(['Region', 'region']),
    appellation: get(['Appellation', 'appellation']),
    type: mapWineType(get(['Wine type', 'Wine Type', 'wine type', 'Type', 'type'])),
    price: isNaN(price) ? undefined : price,
    currency: get(['Currency', 'currency']) || undefined,
    bottleSize: get(['Bottle size', 'Bottle Size', 'bottle size', 'Size']) || '750ml',
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: get(['Purchase date', 'Purchase Date', 'purchase date', 'Date']),
    purchaseLocation: get(['Store name', 'Store', 'store', 'Purchase Location']),
    notes,
    rating: isNaN(rating) ? undefined : rating,
    ratingScale: inferRatingScale(rating),
    drinkFrom,
    drinkTo,
    // Scan-history exports: when the user picks "drinking history" in the
    // import UI, this becomes consumedAt. Stripped before items are sent to
    // the backend either way (see ImportBottles' mode transform).
    scanDate: tryParseDate(get(['Scan date', 'Scan Date'])),
    location: get(['Location', 'location', 'Bin', 'bin']),
    ...mapRackFields(get),
  };
}

// ── CellarTracker Mappers ───────────────────────────────────────────────────
//
// CellarTracker ("CT") has TWO export paths and SIX table shapes:
//
//   A. Browser UI (My Cellar → Export): Windows-1252 CSV, sometimes truncated
//      to 25 rows ("Only wines on this page" default), header names can drift
//      (MyScore vs MY). Handled by the loose `mapCellarTrackerRow` fallback.
//   B. WebQuery (xlquery.asp): UTF-8 TSV/CSV, one of six tables — List,
//      Inventory, Bottles, Consumed, Purchase, Pending — each with a
//      different row grain and column set. Fingerprinted by
//      `detectCellarTrackerTable` and handled by a per-table mapper.
//
// CT sentinel values (never data):
//   Vintage 1001            → non-vintage ('NV')
//   9999 (vintage/windows)  → unknown / no drink window → null
//   (n/a) / (pending) / (unknown) / Unknown → empty
//
// The `CT` column is the community average score — never imported. The
// user's own score is `MY` (WebQuery) / `MyScore` (browser CSV), 100-scale.

const CT_SENTINELS = new Set(['(n/a)', '(pending)', '(unknown)', 'unknown']);

/** Trim a CT field and blank out CT's placeholder sentinels. */
function ctClean(value) {
  const s = (value || '').trim();
  return CT_SENTINELS.has(s.toLowerCase()) ? '' : s;
}

/** Vintage: 1001 → 'NV' (CT's non-vintage sentinel), 9999/blank → ''. */
function ctVintage(value) {
  const s = (value || '').trim();
  if (s === '1001') return 'NV';
  if (s === '9999') return '';
  return s;
}

/** Drink-window year: integer, or null for blank/9999/1001 sentinels. */
function ctDrinkYear(value) {
  const n = parseInt((value || '').trim(), 10);
  if (!Number.isFinite(n) || n === 9999 || n === 1001) return null;
  return n;
}

/**
 * CT dates are US M/D/YYYY ("5/25/2020"). Parse month-first explicitly —
 * never via `new Date(string)`, whose interpretation of slashed dates is
 * implementation/locale lore. Falls back to tryParseDate for ISO strings.
 */
function ctDate(value) {
  const s = (value || '').trim();
  if (!s) return undefined;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return tryParseDate(s);
}

/** Grapes: Varietal → MasterVarietal, skipping the literal 'Unknown'. */
function ctGrapes(get) {
  const v = ctClean(get(['Varietal'])) || ctClean(get(['MasterVarietal']));
  return v ? [v] : undefined;
}

/**
 * CT `Locale` is the full "Country, Region, SubRegion, Appellation" path
 * (2–4 parts). Used when a table has no dedicated Country/Region columns
 * (the Bottles table) or they're blank.
 */
function parseCtLocale(locale) {
  const parts = (locale || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    country: parts[0] || '',
    region: parts[1] || '',
    appellation: parts.length > 2 ? parts[parts.length - 1] : '',
  };
}

/**
 * CT wine types are compound ("White - Sweet/Dessert", "Red - Fortified",
 * "White - Sparkling", "Port", "Spirits"). Unlike the generic mapWineType,
 * the style suffix must win over the base colour, so check fortified/
 * sparkling/dessert BEFORE red/white.
 */
// CellarTracker's `Type` mixes colour and style ("White - Sweet/Dessert"), and
// its `Color`/`Category` columns state them separately. All three are read:
// Type first because it is the richest, then Color as the plain colour, with
// Category available to the caller for the style.
//
// ⚠️ `spirits` and `whisky` used to map to 'fortified'. They are not fortified
// WINE — a CT cellar routinely holds whisky, and calling it a fortified wine
// put a spirit into the wine registry wearing a wine type. They now return
// null, and looksNonWine() lets the caller flag the row instead.
function mapCellarTrackerType(typeStr, colorStr) {
  const t = (typeStr || '').toLowerCase();
  if (looksNonWine(t)) return null;
  if (t.includes('fortified') || t.includes('port') || t.includes('sherry') || t.includes('madeira')) return 'fortified';
  if (t.includes('sparkling') || t.includes('champagne')) return 'sparkling';
  if (t.includes('sweet') || t.includes('dessert') || t.includes('ice wine')) return 'dessert';
  if (t.includes('rosé') || t.includes('rose')) return 'rosé';
  if (t.includes('white')) return 'white';
  if (t.includes('red')) return 'red';
  // Type said nothing usable — fall back to the dedicated Color column, which
  // carries a clean Red/White/Rosé/Other, then to the generic mapper.
  return mapWineType(typeStr) || mapWineType(colorStr);
}

/**
 * Location + Bin joined into Cellarion's freeform location string, plus the
 * raw pair kept on transient `_ctLocation`/`_ctBin` fields so parseAndMap's
 * rack auto-map pass (applyCtRackAutoMap) can group bins per Location. The
 * transient fields are ALWAYS deleted before parseAndMap returns.
 */
function ctPlacementFields(get) {
  const location = ctClean(get(['Location', 'location']));
  const bin = ctClean(get(['Bin', 'bin']));
  return {
    location: [location, bin].filter(Boolean).join(' / '),
    _ctLocation: location,
    _ctBin: bin,
  };
}

/**
 * The user's own 100-point score. `MY` in WebQuery exports, `MyScore` in
 * browser-UI CSVs. 0/blank = no score. (The `CT` community average is
 * deliberately NOT an alias here.)
 */
function ctMyRating(get) {
  const n = parseLocaleNumber(get(['MY', 'MyScore']));
  return isNaN(n) || n <= 0 ? undefined : n;
}

/**
 * Price + currency. `Price`/`BottleCost` are in the ACCOUNT currency; when
 * `NativePrice`/`NativePriceCurrency` record a different original purchase
 * currency, prefer the native pair — that is what Cellarion's price field
 * means. CT stores 0 for "no price recorded" → undefined.
 */
function ctMoney(get, { priceKeys = ['Price'], currencyKeys = ['Currency'] } = {}) {
  const accountPrice = parseLocaleNumber(get(priceKeys));
  const accountCurrency = get(currencyKeys) || undefined;
  const nativePrice = parseLocaleNumber(get(['NativePrice']));
  const nativeCurrency = get(['NativePriceCurrency']);
  if (!isNaN(nativePrice) && nativePrice > 0 && nativeCurrency && nativeCurrency !== accountCurrency) {
    return { price: nativePrice, currency: nativeCurrency };
  }
  return {
    price: isNaN(accountPrice) || accountPrice <= 0 ? undefined : accountPrice,
    currency: accountCurrency,
  };
}

/** Map CT's ShortType/ConsumptionType to Cellarion's consumedReason enum. */
function ctConsumedReason(shortType) {
  const s = (shortType || '').toLowerCase();
  if (!s || s.includes('drank') || s.includes('drink')) return 'drank';
  if (s.includes('gift')) return 'gifted';
  if (s.includes('sold') || s.includes('sale')) return 'sold';
  return 'other';
}

/** Join per-bottle note fields (BottleNote / PNotes / PurchaseNote). */
function joinCtNotes(...notes) {
  return notes.map((n) => (n || '').trim()).filter(Boolean).join('\n');
}

const CT_PRODUCER_PREFIX_RE =
  /^(Château|Chateau|Domaine|Clos|Castello|Tenuta|Bodegas?|Weingut|Cantina|Quinta|Mas)$/i;
const CT_PRODUCER_PARTICLE_RE =
  /^(de|du|des|la|le|les|di|del|della|dei|degli|do|dos|da|das|y|e|&|van|von|zu|zur)$/i;

/**
 * Best-effort producer guess from CT's "Wine" display name (which leads with
 * the producer) when no Producer column exists. If the name starts with a
 * producer-prefix word (Château/Domaine/…), take the prefix plus any name
 * particles plus one substantive token, so
 *   "Domaine de la Romanée-Conti La Tâche" → "Domaine de la Romanée-Conti"
 *   "Château Margaux"                      → "Château Margaux"
 * Otherwise keep the legacy rule: first word of a >2-word name.
 */
export function guessProducerFromWineName(wineName) {
  if (!wineName) return '';
  const parts = wineName.trim().split(/\s+/);
  if (parts.length < 2) return '';
  if (CT_PRODUCER_PREFIX_RE.test(parts[0])) {
    let end = 1;
    while (end < parts.length && CT_PRODUCER_PARTICLE_RE.test(parts[end])) end++;
    if (end < parts.length) end++; // the substantive token
    return parts.slice(0, end).join(' ');
  }
  return parts.length > 2 ? parts[0] : '';
}

/**
 * CT's "Wine" display name includes the producer prefix ("Vega Sicilia
 * Único"). When a real Producer column value is present and the name starts
 * with it, strip the prefix for a cleaner wineName — unless stripping would
 * empty it (wine named exactly after the producer, e.g. "Pétrus").
 */
export function stripProducerPrefix(wineName, producer) {
  if (!wineName || !producer) return wineName;
  if (wineName.toLowerCase().startsWith(producer.toLowerCase())) {
    const rest = wineName.slice(producer.length).replace(/^[\s\-–—:,]+/, '').trim();
    if (rest) return rest;
  }
  return wineName;
}

// ── Classification-in-name guard (somm ticket 0063bb76) ─────────────────────
//
// Once the producer prefix is stripped, a Bordeaux "Wine" value like
// "Château Talbot Grand Cru Classé" leaves just the CLASSIFICATION tier —
// and that string used to be stored as the wine's NAME. Prod grew 19 such
// rows (three distinct wines all named "Grand Cru Classé"), six of them
// duplicating a properly-named record of the same château. A tier is routed
// to `classification`; the name gets whatever substantive part remains, or
// falls back to the producer (the grand-vin convention — Château Margaux's
// wine IS "Château Margaux").
//
// Deliberately requires "classé"/"bourgeois": Burgundy's "1er Cru" alone is
// part of real appellation-carrying names ("Chassagne-Montrachet 1er Cru Les
// Fairendes") and must never trip this.

const TIER_RE = /(premier\s+grand\s+cru\s+class[eé]s?|second\s+grand\s+cru\s+class[eé]s?|deuxi[eè]me\s+cru\s+class[eé]s?|grand\s+cru\s+class[eé]s?|premier\s+cru\s+class[eé]s?|cru\s+class[eé]s?|cru\s+bourgeois(?:\s+sup[eé]rieur)?)/i;

const TIER_CANONICAL = new Map([
  ['premier grand cru classe', 'Premier Grand Cru Classé'],
  ['second grand cru classe', 'Second Grand Cru Classé'],
  ['deuxieme cru classe', 'Deuxième Cru Classé'],
  ['grand cru classe', 'Grand Cru Classé'],
  ['premier cru classe', 'Premier Cru Classé'],
  ['cru classe', 'Cru Classé'],
  ['cru bourgeois', 'Cru Bourgeois'],
  ['cru bourgeois superieur', 'Cru Bourgeois Supérieur'],
]);

const foldAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normTier = (s) => TIER_CANONICAL.get(foldAccents(s).toLowerCase().replace(/s$/, '').replace(/\s+/g, ' ').trim()) || null;

// Words that don't make a leftover a real cuvée name: the row's own
// appellation/region tokens, plus label furniture ("Grand Vin", AOC noise).
const NAME_NOISE = new Set(['grand', 'vin', 'cru', 'aoc', 'ac', 'appellation', 'controlee', 'de', 'du', 'la', 'le', 'les', 'des']);
function isAppellationNoise(remainder, appellation, region) {
  const allowed = new Set(NAME_NOISE);
  for (const src of [appellation, region]) {
    for (const t of foldAccents(src).toLowerCase().split(/[^a-z0-9]+/)) if (t) allowed.add(t);
  }
  return foldAccents(remainder).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .every((t) => allowed.has(t));
}

/**
 * Split a classification tier out of a wine name. Returns
 * { wineName, classification } — classification undefined when no tier found.
 */
export function splitClassificationFromName(wineName, { producer, appellation, region } = {}) {
  const name = String(wineName || '').trim();
  if (!name) return { wineName, classification: undefined };

  // Trailing parenthesised tier: "Margaux (Grand Cru Classé)". The remainder
  // re-runs through the splitter — "Saint-Émilion Grand Cru (Grand Cru
  // Classé)" still has appellation noise to shed.
  const paren = name.match(/^(.*?)\s*\(\s*([^)]*(?:cru\s+class[eé]|cru\s+bourgeois)[^)]*)\s*\)\s*$/i);
  if (paren) {
    const inner = normTier(paren[2]) || paren[2].trim();
    const again = splitClassificationFromName(paren[1], { producer, appellation, region });
    // The part before the parens gets the same "is it a real name" test as
    // the inline case — "Margaux (Grand Cru Classé)" leaves only appellation.
    const base = again.wineName && !isAppellationNoise(again.wineName, appellation, region)
      ? again.wineName
      : ((producer || '').trim() || name);
    return { wineName: base, classification: again.classification || inner };
  }

  const m = name.match(TIER_RE);
  if (!m) return { wineName: name, classification: undefined };
  const tier = normTier(m[0]) || m[0].trim();
  const remainder = (name.slice(0, m.index) + ' ' + name.slice(m.index + m[0].length))
    .replace(/[\s,;:()–—-]+/g, ' ').trim();
  if (remainder && !isAppellationNoise(remainder, appellation, region)) {
    // A real cuvée survives the strip: "Clos des Jacobins", "Réserve du Château".
    return { wineName: remainder, classification: tier };
  }
  // Nothing substantive left — a designation is not a name; the grand vin
  // carries the estate's own. No producer to fall back on leaves the name
  // unchanged rather than minting an empty one.
  return { wineName: (producer || '').trim() || name, classification: tier };
}

// ── Appellation-first names (registry backlog 2026-09-06) ───────────────────
//
// CT composes "Wine" as producer + appellation + designation ("Bodegas Muga
// Rioja Prado Enea Gran Reserva"). After the producer prefix goes, the name
// still leads with the appellation while the registry keeps the designation
// alone ("Prado Enea Gran Reserva"); a re-import of one such file re-created
// its whole request queue. When the row's Appellation (or Region) opens the
// name, drop it — unless what is left is a bare style word ("Reserva"), which
// is not a name. CT's own Designation column, when present and matching the
// remainder, is used verbatim so the file's spelling and case survive.
const APPELLATION_TIER_WORDS = /\b(docg|doca|doc|dop|aoc|aop|igt|igp|ava|gi|do|vdp|vdqs)\b/g;
// A remainder made only of styles and grapes is not a name: "Rioja Reserva"
// → "Reserva", and a Mosel row whose CT Appellation is the single vineyard
// ("Wehlener Sonnenuhr Riesling Auslese") must keep the vineyard, because
// that is the wine's name. Mirrors services/wineMatching.js on the server.
const GENERIC_NAME_WORDS = new Set([
  'reserva', 'gran', 'grande', 'riserva', 'reserve', 'crianza', 'joven', 'classico', 'superiore',
  'brut', 'extra', 'sec', 'demi', 'dry', 'trocken', 'feinherb', 'halbtrocken', 'kabinett', 'spatlese',
  'auslese', 'beerenauslese', 'trockenbeerenauslese', 'eiswein', 'gg', 'grosses', 'groes', 'gewachs', 'erstes',
  'rouge', 'blanc', 'rose', 'rosado', 'bianco', 'rosso', 'tinto', 'branco', 'red', 'white', 'sekt',
  'riesling', 'chardonnay', 'pinot', 'noir', 'gris', 'grigio', 'blanco', 'sauvignon', 'merlot', 'cabernet',
  'franc', 'syrah', 'shiraz', 'grenache', 'garnacha', 'tempranillo', 'sangiovese', 'nebbiolo', 'barbera',
  'dolcetto', 'malbec', 'zinfandel', 'gewurztraminer', 'gruner', 'veltliner', 'chenin', 'viognier', 'muscat',
  'moscato', 'mourvedre', 'carignan', 'gamay', 'mencia', 'garganega', 'albarino', 'alvarinho', 'verdejo',
  'godello', 'touriga', 'nacional', 'franca', 'spatburgunder', 'weissburgunder', 'grauburgunder', 'silvaner',
  'sylvaner', 'muller', 'thurgau', 'blaufrankisch', 'zweigelt', 'semillon', 'primitivo', 'aglianico',
  'montepulciano', 'corvina', 'glera', 'trebbiano', 'vermentino', 'verdicchio', 'fiano', 'greco', 'nero',
  'davola', 'carmenere', 'petit', 'verdot', 'roussanne', 'marsanne', 'cinsault', 'furmint', 'assyrtiko',
]);
const foldForPrefix = (s) => foldAccents(String(s || '')).toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const isGenericRemainder = (folded) => folded.split(' ').filter(Boolean).every((t) => GENERIC_NAME_WORDS.has(t));

export function stripAppellationPrefixFromName(wineName, { appellation, region, designation } = {}) {
  const name = String(wineName || '').trim();
  if (!name) return wineName;
  const nameWords = name.split(/\s+/);
  for (const hint of [appellation, region]) {
    const head = foldForPrefix(hint).replace(APPELLATION_TIER_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (!head) continue;
    const headWords = head.split(' ');
    if (headWords.length >= nameWords.length) continue;
    const lead = foldForPrefix(nameWords.slice(0, headWords.length).join(' '));
    if (lead !== head) continue;
    const remainderWords = nameWords.slice(headWords.length);
    const remainder = remainderWords.join(' ');
    if (isGenericRemainder(foldForPrefix(remainder))) return name;
    const des = String(designation || '').trim();
    if (des && foldForPrefix(des) === foldForPrefix(remainder)) return des;
    return remainder;
  }
  return name;
}

/** wineName + producer from a CT row (Producer column or heuristic). */
function ctIdentity(get) {
  const rawWine = get(['Wine', 'wine', 'WineName']);
  const producerCol = ctClean(get(['Producer', 'producer']));
  if (producerCol) {
    return { wineName: stripProducerPrefix(rawWine, producerCol), producer: producerCol };
  }
  return { wineName: rawWine, producer: guessProducerFromWineName(rawWine) };
}

/** Fields shared by all CT table mappers. */
function ctCommonFields(get, { sizeKeys = ['Size'] } = {}) {
  const identity = ctIdentity(get);
  const locale = parseCtLocale(get(['Locale']));
  const region = get(['Region']) || locale.region;
  const appellation = ctClean(get(['Appellation'])) || locale.appellation;
  // After producer-stripping, a Bordeaux Wine value can be pure tier
  // ("Grand Cru Classé") — route it to classification, never the name.
  const { wineName: tieredName, classification } = splitClassificationFromName(
    identity.wineName, { producer: identity.producer, appellation, region });
  const wineName = stripAppellationPrefixFromName(tieredName, { appellation, region, designation: ctClean(get(['Designation', 'designation'])) });
  const rating = ctMyRating(get);
  return {
    wineName,
    producer: identity.producer,
    classification,
    vintage: ctVintage(get(['Vintage'])) || 'NV',
    country: get(['Country']) || locale.country,
    region,
    appellation,
    type: mapCellarTrackerType(get(['Type']), get(['Color', 'Colour'])),
    // CT tracks spirits beside wine; the caller flags rather than guesses.
    nonWineHint: looksNonWine(get(['Type']), get(['Category'])) || undefined,
    bottleSize: normalizeBottleSize(get(sizeKeys)) || '750ml',
    ...ctPlacementFields(get),
    rating,
    ratingScale: rating !== undefined ? '100' : undefined,
    grapes: ctGrapes(get),
    drinkFrom: ctDrinkYear(get(['BeginConsume'])),
    drinkTo: ctDrinkYear(get(['EndConsume'])),
  };
}

// -- Per-table mappers (WebQuery fingerprinted files) ------------------------
// Items flagged `_ctPending` are pending (undelivered) purchases — Cellarion
// has no on-order state, so parseAndMap skips them and reports a warning.

/** List: one row per WINE with Quantity (+ Pending). Quantity expands to N
 *  bottles; Quantity 0 + Pending > 0 rows are on-order only → skipped. */
function mapCtListRow(row) {
  const get = makeGetter(row);
  const qty = parseInt(get(['Quantity']), 10);
  const pending = parseInt(get(['Pending']), 10) || 0;
  const item = {
    ...ctCommonFields(get),
    ...ctMoney(get),
    quantity: Number.isNaN(qty) ? 1 : qty,
  };
  if (item.quantity === 0 && pending > 0) {
    item._ctPending = true;
    item._ctPendingCount = pending;
  }
  return item;
}

/** Inventory: one row per physical in-cellar bottle (plus pending rows,
 *  marked Location "(pending)", which are skipped). */
function mapCtInventoryRow(row) {
  const get = makeGetter(row);
  const item = {
    ...ctCommonFields(get),
    ...ctMoney(get),
    quantity: 1,
    purchaseDate: ctDate(get(['PurchaseDate'])),
    purchaseLocation: ctClean(get(['StoreName', 'Store'])),
    notes: joinCtNotes(get(['BottleNote']), get(['PNotes'])),
  };
  if ((get(['Location']) || '').trim().toLowerCase() === '(pending)') {
    item._ctPending = true;
  }
  return item;
}

/** Bottles: one row per bottle in ANY state.
 *  BottleState: -1 = pending (skip), 0 = consumed (history), 1 = in cellar. */
function mapCtBottlesRow(row) {
  const get = makeGetter(row);
  const common = ctCommonFields(get, { sizeKeys: ['BottleSize', 'Size'] });
  const state = get(['BottleState']).trim();
  if (state === '-1') {
    return { ...common, quantity: 1, _ctPending: true };
  }
  const qty = parseInt(get(['Quantity']), 10);
  const item = {
    ...common,
    ...ctMoney(get, { priceKeys: ['BottleCost'], currencyKeys: ['BottleCostCurrency'] }),
    quantity: Number.isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: ctDate(get(['PurchaseDate'])),
    purchaseLocation: ctClean(get(['Store', 'StoreName'])),
    notes: joinCtNotes(get(['BottleNote']), get(['PurchaseNote'])),
  };
  const consumedAt = ctDate(get(['ConsumptionDate']));
  if (state === '0' || consumedAt) {
    item.addToHistory = true;
    item.consumedAt = consumedAt;
    item.consumedReason = ctConsumedReason(get(['ShortType', 'ConsumptionType']));
    item.consumedNote = get(['ConsumptionNote']) || undefined;
  }
  return item;
}

/** Consumed: one row per consumption event → drink-history entry.
 *  NB: `cNotes` is a community-note COUNT, never note text — not mapped. */
function mapCtConsumedRow(row) {
  const get = makeGetter(row);
  return {
    ...ctCommonFields(get),
    ...ctMoney(get, { priceKeys: ['Price', 'Value'] }),
    quantity: 1,
    notes: joinCtNotes(get(['BottleNote']), get(['PurchaseNote'])),
    addToHistory: true,
    consumedAt: ctDate(get(['Consumed'])),
    consumedReason: ctConsumedReason(get(['ShortType'])),
    consumedNote: get(['ConsumptionNote']) || undefined,
  };
}

/** Purchase / Pending: one row per purchase ORDER with Quantity — expanded.
 *  The two tables share a schema; a file whose rows are all Delivered=False
 *  is relabeled 'pending' by parseAndMap. */
function mapCtPurchaseRow(row) {
  const get = makeGetter(row);
  const qty = parseInt(get(['Quantity']), 10);
  return {
    ...ctCommonFields(get),
    ...ctMoney(get),
    quantity: Number.isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: ctDate(get(['PurchaseDate'])),
    purchaseLocation: ctClean(get(['StoreName', 'Store'])),
  };
}

const CT_TABLE_MAPPERS = {
  list: mapCtListRow,
  inventory: mapCtInventoryRow,
  bottles: mapCtBottlesRow,
  consumed: mapCtConsumedRow,
  purchase: mapCtPurchaseRow,
};

/**
 * Fingerprint WHICH CellarTracker table a header row belongs to.
 * Returns 'list' | 'inventory' | 'bottles' | 'consumed' | 'purchase' |
 * 'availability' | null (null → loose mapCellarTrackerRow fallback, which
 * also covers browser-UI CSV exports whose headers drift).
 * Note: 'availability' is a statistics table and is REJECTED by parseAndMap.
 * Order matters — Availability also carries iWine/Pending/Wine columns.
 */
export function detectCellarTrackerTable(headers) {
  const h = new Set(headers.map((s) => s.trim().toLowerCase()));
  if (h.has('available') && h.has('linear')) return 'availability';
  if (h.has('iconsumed')) return 'consumed';
  if (h.has('ipurchase')) return 'purchase';
  if (h.has('bottlestate') && h.has('iwine') && h.has('bottlesize')) return 'bottles';
  if (h.has('iwine') && h.has('barcode') && h.has('bottlenote')) return 'inventory';
  if (h.has('iwine') && h.has('quantity') && h.has('pending') && h.has('wine')) return 'list';
  return null;
}

/**
 * Loose CellarTracker fallback for files detected as CT but not matching a
 * WebQuery table fingerprint (browser-UI CSV exports with drifting headers).
 */
function mapCellarTrackerRow(row) {
  const get = makeGetter(row);

  const { wineName, producer } = ctIdentity(get);

  const price = parseLocaleNumber(get(['Price', 'price', 'Cost']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'Count']), 10);

  // Personal score first (MY / MyScore, always 100-scale); legacy aliases
  // as fallback. The `CT` community-average column is never imported.
  const myRating = ctMyRating(get);
  const legacyRating = parseLocaleNumber(get(['MyCTRating', 'CT Rating', 'My Rating', 'Rating']));
  const rating = myRating !== undefined ? myRating : (isNaN(legacyRating) ? undefined : legacyRating);

  const locale = parseCtLocale(get(['Locale']));

  return {
    wineName,
    producer,
    vintage: ctVintage(get(['Vintage', 'vintage', 'Year'])) || 'NV',
    country: get(['Country', 'country']) || locale.country,
    region: get(['Region', 'region', 'Sub-Region']) || locale.region,
    appellation: ctClean(get(['Appellation', 'appellation', 'SubRegion'])) || locale.appellation,
    type: mapCellarTrackerType(get(['Type', 'type']), get(['Color', 'Colour', 'Category', 'category'])),
    nonWineHint: looksNonWine(get(['Type', 'type']), get(['Category', 'category'])) || undefined,
    price: isNaN(price) ? undefined : price,
    currency: get(['Currency', 'currency']) || undefined,
    bottleSize: normalizeBottleSize(get(['Size', 'size', 'Bottle Size', 'BottleSize'])) || '750ml',
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: ctDate(get(['PurchaseDate', 'Purchase Date', 'Date Purchased'])),
    purchaseLocation: ctClean(get(['Store', 'store', 'StoreName', 'Purchase Location', 'Vendor'])),
    notes: get(['Notes', 'notes', 'MyNotes', 'Tasting Notes', 'Review']),
    rating,
    ratingScale: myRating !== undefined ? '100' : inferRatingScale(legacyRating),
    ...ctPlacementFields(get),
    grapes: ctGrapes(get),
    drinkFrom: ctDrinkYear(get(['BeginConsume'])),
    drinkTo: ctDrinkYear(get(['EndConsume'])),
    ...mapRackFields(get),
  };
}

// ── Generic CSV Mapper ──────────────────────────────────────────────────────

function mapGenericRow(row) {
  const get = makeGetter(row);

  const price = parseLocaleNumber(get(['Price', 'price', 'Cost', 'cost']));
  const rating = parseLocaleNumber(get(['Rating', 'rating', 'Score', 'score']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'qty', 'Count', 'count']), 10);

  // Combined rack+position columns like Oeno's "Rack_Location" = "M2-11"
  const combined = get(['Rack_Location', 'Rack Location', 'RackLocation', 'Bin Location', 'BinLocation']);
  const parsedRack = parseCombinedRackLocation(combined);
  const rackFields = mapRackFields(get);

  const producer = get(['Producer', 'producer', 'Winery', 'winery', 'Maker', 'maker']);
  const region = get(['Region', 'region']);
  const appellation = get(['Appellation', 'appellation', 'Sub-Region', 'SubRegion']);
  // Same tier-in-name guard as the CT path (somm ticket 0063bb76) — plus an
  // explicit Classification column, which some hand-written files carry.
  const { wineName, classification } = splitClassificationFromName(
    get(['Wine', 'wine', 'Wine Name', 'WineName', 'Name', 'name']),
    { producer, appellation, region });

  return {
    wineName,
    producer,
    classification: classification || get(['Classification', 'classification']) || undefined,
    vintage: get(['Vintage', 'vintage', 'Year', 'year']) || 'NV',
    country: get(['Country', 'country']),
    region,
    appellation,
    type: mapWineType(get(['Type', 'type', 'Color', 'Colour', 'Category', 'category'])),
    price: isNaN(price) ? undefined : price,
    currency: get(['Currency', 'currency']) || undefined,
    bottleSize: normaliseBottleSize(get(['Size', 'size', 'Bottle Size', 'BottleSize'])) || '750ml',
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: get(['Purchase Date', 'PurchaseDate', 'Date', 'date']),
    purchaseLocation: get(['Store', 'store', 'Purchase Location', 'Vendor', 'vendor']),
    notes: get(['Notes', 'notes', 'Note', 'note', 'Comments', 'comments']),
    rating: isNaN(rating) ? undefined : rating,
    ratingScale: inferRatingScale(rating),
    location: get(['Location', 'location', 'Bin', 'bin']),
    ...rackFields,
    // Generic-only: combined "Rack_Location"-style columns take precedence
    // over the shared rack aliases for rackName/rackPosition.
    rackName: parsedRack?.rackName || rackFields.rackName,
    rackPosition: parsedRack?.rackPosition || rackFields.rackPosition,
  };
}

// ── Cellarion CSV Mapper ─────────────────────────────────────────────────────

/**
 * Map a row from Cellarion's own CSV export.
 * Headers are already in master format (camelCase), so pass through directly.
 *
 * Cellarion exports are one row per bottle and carry no quantity column, but
 * hand-written files in this format legitimately use one — honor it like the
 * other mappers do (parseAndMap expands quantity > 1 into individual items).
 */
function mapCellarionRow(row) {
  const str = (key) => (row[key] || '').trim();
  const num = (key) => { const n = parseLocaleNumber(row[key]); return isNaN(n) ? undefined : n; };
  const int = (key) => { const n = parseInt(row[key], 10); return isNaN(n) ? undefined : n; };

  const qty = parseInt(row.quantity ?? row.Quantity ?? row.qty ?? row.Qty, 10);

  return {
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    wineName: str('wineName'),
    producer: str('producer'),
    vintage: str('vintage') || 'NV',
    country: str('country'),
    region: str('region'),
    appellation: str('appellation'),
    type: mapWineType(str('type')),
    price: num('price'),
    currency: str('currency') || undefined,
    bottleSize: str('bottleSize') || '750ml',
    purchaseDate: str('purchaseDate'),
    purchaseLocation: str('purchaseLocation'),
    purchaseUrl: str('purchaseUrl') || undefined,
    location: str('location'),
    notes: str('notes'),
    rating: num('rating'),
    ratingScale: str('ratingScale') || undefined,
    rackName: str('rackName') || undefined,
    rackPosition: int('rackPosition'),
    row: int('row'),
    col: int('col'),
    rackRows: int('rackRows'),
    rackCols: int('rackCols'),
    rackType: str('rackType') || undefined,
    dateAdded: str('dateAdded') || undefined,
    addToHistory: str('addToHistory') || undefined,
    consumedReason: str('consumedReason') || undefined,
    consumedAt: str('consumedAt') || undefined,
    consumedNote: str('consumedNote') || undefined,
    consumedRating: num('consumedRating'),
    consumedRatingScale: str('consumedRatingScale') || undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tryParseDate(str) {
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

/**
 * Parse a Cellarion JSON export (or plain array) into master import format.
 *
 * Accepts:
 *   - Current cellar export (cellarion-export@1): { schema, cellars: [ { cellarName, bottles: [...] } ] }
 *     \u2014 bottles from all exported cellars are flattened into one list
 *   - Legacy single-cellar export object: { cellarName, exportedAt, bottles: [...] }
 *   - Plain array of items already in master format
 *
 * @param {string} text - Raw JSON text
 * @returns {{ items: object[], format: string, headers: string[] }}
 */
export function parseJSON(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Invalid JSON file');
  }

  let raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bottles) ? parsed.bottles : null);
  if (!raw && Array.isArray(parsed.cellars)) {
    // cellarion-export@1 (the "Export cellar data" download): bottles are
    // nested per cellar; their items are already in master format.
    raw = parsed.cellars.flatMap((c) => (Array.isArray(c?.bottles) ? c.bottles : []));
  }
  if (!raw) throw new Error('JSON must be an array or a Cellarion export object with a "bottles" array');

  const items = [];
  for (const row of raw) {
    if (!row.wineName && !row.producer) continue;

    const item = { ...row };

    // Normalise dates
    if (item.purchaseDate) item.purchaseDate = tryParseDate(item.purchaseDate);
    if (item.consumedAt)   item.consumedAt   = tryParseDate(item.consumedAt);
    if (item.dateAdded)    item.dateAdded    = tryParseDate(item.dateAdded);

    // Expand quantity (if present)
    const qty = item.quantity || 1;
    delete item.quantity;

    for (let q = 0; q < qty; q++) {
      items.push({ ...item });
    }
  }

  const headers = items.length > 0 ? Object.keys(items[0]) : [];
  return { items, format: 'cellarion', headers };
}

// \u2500\u2500 Oeno-by-Vintec export (real) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Parse Oeno's real two-section CSV export.
 *
 * The file is structured as:
 *   1. Cabinet/layer definitions \u2014 one row per (cabinet, column, shelf,
 *      layer-front-back). Includes "Disabled Slots" so we know which
 *      positions are unusable. Total/Empty Slots are cabinet-level stats.
 *   2. A blank-row separator + literal "User Bottles Details" marker.
 *   3. Bottle records \u2014 one row per individual bottle, joining to a
 *      specific layer via Layer ID and indicating its slot within that
 *      layer. Cabinet fields can all be "null" for unshelved bottles.
 *
 * The parser maps each (cabinet, column) pair into a Cellarion shelf rack
 * sized for that column's shelves with cols=6, backCols=5, bpc=1 (Vintec/
 * Transtherm standard \u2014 users can override in the picker). Each bottle
 * carries an explicit shelf number, layer (1=front, 2=back), and
 * slotInLayer; the backend's computeRackPosition uses those to compute
 * the exact Cellarion slot.
 *
 * Consumed bottles (Consumed On set) come in via the existing
 * addToHistory path. Unshelved bottles (Cabinet ID = null) skip rack
 * placement.
 *
 * @param {string} text - Raw CSV text
 * @returns {{ items: object[], format: 'oeno-export', headers: string[], oenoRackSpecs: object }}
 *   `oenoRackSpecs` is keyed by rack name and used by the picker's
 *   default-rack-config helper to pre-fill cabinet shapes.
 */
export function parseOenoExport(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/);
  const boundary = detectOenoExportBoundary(lines);
  if (boundary === -1) {
    return null;
  }

  // \u2500\u2500 Section 1: cabinet/layer definitions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Lookup map: Layer ID (string) \u2192 { cabinetId, cabinetLabel, cabinetBrand,
  //   cabinetModel, columnIndex, shelfIndex, layerIndex, disabledSlots:Set }
  const layerById = new Map();
  // Per-cabinet metadata for the rack-spec output
  const cabinetById = new Map();

  // Section 1 has a header row at index 0
  for (let i = 1; i < boundary; i++) {
    const cells = splitCSVLine(lines[i]);
    if (!cells[0] || !cells[0].trim()) continue;
    const cabinetId = cells[0].trim();
    if (!cabinetId) continue;

    const cabinetLabel = (cells[1] || '').trim();
    const cabinetBrand = (cells[2] || '').trim();
    const cabinetModel = (cells[3] || '').trim();
    const columnIndex = parseInt(cells[4], 10);
    const shelfIndex = parseInt(cells[5], 10);
    const layerIndex = parseInt(cells[6], 10);
    const layerId = (cells[7] || '').trim();

    if (!layerId || isNaN(columnIndex) || isNaN(shelfIndex) || isNaN(layerIndex)) continue;

    // "Disabled Slots" is a comma-separated list inside the field (which is
    // itself comma-separated). The CSV parser already handles the quoting,
    // so cells[8] is a raw string like "6, 5" or "0" (meaning none disabled)
    // or "1, 2, 3" etc.
    const disabledRaw = (cells[8] || '').trim();
    const disabledSlots = new Set();
    if (disabledRaw && disabledRaw !== '0') {
      for (const part of disabledRaw.split(',')) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n) && n > 0) disabledSlots.add(n);
      }
    }

    layerById.set(layerId, {
      cabinetId, cabinetLabel, cabinetBrand, cabinetModel,
      columnIndex, shelfIndex, layerIndex, disabledSlots
    });

    if (!cabinetById.has(cabinetId)) {
      cabinetById.set(cabinetId, {
        label: cabinetLabel,
        brand: cabinetBrand,
        model: cabinetModel,
        columns: new Map(), // columnIndex \u2192 { maxShelf }
      });
    }
    const cab = cabinetById.get(cabinetId);
    if (!cab.columns.has(columnIndex)) {
      cab.columns.set(columnIndex, { maxShelf: 0 });
    }
    const col = cab.columns.get(columnIndex);
    if (shelfIndex > col.maxShelf) col.maxShelf = shelfIndex;
  }

  // \u2500\u2500 Section 2: bottle records \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const bottleHeaders = splitCSVLine(lines[boundary]);
  const headerIndex = (name) => bottleHeaders.findIndex(h => h.trim() === name);
  const idx = {
    bottleId: headerIndex('Bottle ID'),
    cabinetId: headerIndex('Cabinet ID'),
    layerId: headerIndex('Layer ID'),
    slot: headerIndex('Slot'),
    size: headerIndex('Bottle Size Liters'),
    year: headerIndex('Wine Year'),
    type: headerIndex('Wine Type'),
    note: headerIndex('Bottle Note'),
    title: headerIndex('Wine Title'),
    country: headerIndex('Wine Country'),
    region: headerIndex('Wine Region'),
    winery: headerIndex('Wine Winery'),
    cost: headerIndex('Purchase Cost'),
    currency: headerIndex('Purchase Currency'),
    purchase: headerIndex('Purchase Date'),
    consumed: headerIndex('Consumed On'),
  };

  const items = [];
  const rackNameFor = (cabinetLabel, columnIndex, totalColumns) =>
    totalColumns > 1 ? `${cabinetLabel} \u2013 Module ${columnIndex}` : cabinetLabel;

  for (let i = boundary + 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    if (!cells[idx.bottleId] || !cells[idx.bottleId].trim()) continue;

    const cabinetIdRaw = (cells[idx.cabinetId] || '').trim();
    const layerIdRaw = (cells[idx.layerId] || '').trim();
    const slotRaw = (cells[idx.slot] || '').trim();
    const isUnshelved = !cabinetIdRaw || cabinetIdRaw === 'null';

    const sizeLitres = parseLocaleNumber(cells[idx.size]);
    const bottleSize = isNaN(sizeLitres) ? '750ml' : `${Math.round(sizeLitres * 1000)}ml`;
    const cost = parseLocaleNumber(cells[idx.cost]);
    const consumedAt = (cells[idx.consumed] || '').trim();

    const baseItem = {
      wineName: (cells[idx.title] || '').trim(),
      producer: (cells[idx.winery] || '').trim(),
      vintage: (cells[idx.year] || '').trim() || 'NV',
      country: (cells[idx.country] || '').trim(),
      region: (cells[idx.region] || '').trim(),
      type: mapWineType((cells[idx.type] || '').trim()),
      bottleSize,
      notes: (cells[idx.note] || '').trim(),
      price: isNaN(cost) ? undefined : cost,
      currency: (cells[idx.currency] || '').trim() || undefined,
      purchaseDate: tryParseDate((cells[idx.purchase] || '').trim()),
    };

    if (consumedAt) {
      baseItem.addToHistory = true;
      // Normalise like the CSV/JSON paths do — parseOenoExport returns
      // directly from parseAndMap, so its dates skip the shared fix-up loop.
      baseItem.consumedAt = tryParseDate(consumedAt);
      baseItem.consumedReason = 'drank';
    }

    if (isUnshelved) {
      items.push(baseItem);
      continue;
    }

    const layer = layerById.get(layerIdRaw);
    if (!layer) {
      // Layer ID references a layer we don't know \u2014 still import as unshelved
      items.push(baseItem);
      continue;
    }

    const totalColumns = cabinetById.get(layer.cabinetId)?.columns.size || 1;
    items.push({
      ...baseItem,
      rackName: rackNameFor(layer.cabinetLabel, layer.columnIndex, totalColumns),
      // For shelf racks the backend interprets rackPosition as the shelf
      // number (row). layer + slotInLayer pin down the exact cell.
      rackPosition: layer.shelfIndex,
      layer: layer.layerIndex,
      slotInLayer: parseInt(slotRaw, 10) || undefined,
    });
  }

  // Build per-rack default configs so the picker can pre-fill cabinet shapes
  const oenoRackSpecs = {};
  for (const [cabinetId, cab] of cabinetById) {
    const totalColumns = cab.columns.size;
    for (const [columnIndex, col] of cab.columns) {
      const rackName = rackNameFor(cab.label, columnIndex, totalColumns);
      const rows = Math.min(20, col.maxShelf);
      const cols = 6;
      const backCols = 5;
      const bpc = 1;

      // Convert each layer's disabled slot-in-layer indices to GLOBAL Cellarion
      // positions, mirroring the backend's computeRackPosition shelf math with
      // the Oeno bottom-left anchor (shelf 1 = bottom → effectiveShelf =
      // rows - shelfIndex + 1):
      //   shelfBase = (effectiveShelf - 1) × (cols + backCols) × bottlesPerCell
      //   front (layer 1): shelfBase + slotInLayer          (slotInLayer ≤ cols)
      //   back  (layer 2): shelfBase + cols + slotInLayer   (slotInLayer ≤ backCols)
      const disabled = new Set();
      for (const layer of layerById.values()) {
        if (layer.cabinetId !== cabinetId || layer.columnIndex !== columnIndex) continue;
        if (layer.disabledSlots.size === 0) continue;
        // Shelves clamped away by the 20-row cap have no cells to disable
        if (layer.shelfIndex > rows) continue;
        const shelfBase = (rows - layer.shelfIndex) * (cols + backCols) * bpc;
        for (const n of layer.disabledSlots) {
          if (layer.layerIndex === 1 && n <= cols) {
            disabled.add(shelfBase + n);
          } else if (layer.layerIndex === 2 && n <= backCols) {
            disabled.add(shelfBase + cols + n);
          }
        }
      }

      oenoRackSpecs[rackName] = {
        type: 'shelf',
        rows,
        cols,
        typeConfig: { bottlesPerCell: bpc, backCols },
        ...(disabled.size > 0
          ? { disabledPositions: [...disabled].sort((a, b) => a - b) }
          : {}),
      };
    }
  }

  return {
    items,
    format: 'oeno-export',
    headers: bottleHeaders,
    oenoRackSpecs,
  };
}

/**
 * Split one CSV line respecting double-quoted fields (which may contain
 * commas). Same logic as parseCSV's inner splitLine but exposed for the
 * Oeno-export parser to use on individual lines.
 */
function splitCSVLine(line, delimiter = ',') {
  if (!line) return [];
  const fields = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (c === delimiter && !inQ) {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

// ── CellarTracker Location/Bin → rack auto-map ─────────────────────────────

/**
 * Post-pass over the (already quantity-expanded) CellarTracker items:
 * group them by the transient `_ctLocation` field, run the bin-code parser
 * (see binCodeParser.js for the pattern families and the 60% / 3-distinct
 * confidence rule), and — for groups that qualify — emit the SAME rack
 * fields the rest of the pipeline already understands:
 *
 *   rackName            Location name (plus the sub-rack segment for
 *                       3-segment bins: "Offsite Storage 12")
 *   row/col             for grid-shaped patterns
 *   rackPosition        for sequential bins ("147", "BIN3")
 *   rackPosition+layer+slotInLayer  for R<r>C<c>D<d> with front/back depth
 *                       (shelf-rack geometry, same trio as the Oeno path)
 *   rackRows/rackCols(/rackType)    dimension hints for planRackCreations
 *
 * The freeform "Location / Bin" text on `item.location` is ALWAYS kept
 * (belt and braces). Items already carrying rack fields (e.g. an explicit
 * Rack column via the loose mapper) and consumed/history items are never
 * touched. Groups that don't qualify keep today's behaviour wholesale.
 *
 * The transient `_ctLocation`/`_ctBin` markers are deleted from every item.
 *
 * @returns {{
 *   racks: { [rackName]: { pattern, location, binCount, placedCount,
 *            unparsedCount, rows?, cols?, backCols?, spec? } },
 *   textFallback: Array<{ location: string, count: number }>
 * }}
 *   `racks` feeds the upload-step preview cards (pattern label + counts;
 *   `spec` pre-fills the editable rack config). `textFallback` lists
 *   locations whose bottles keep their location as plain text — whole
 *   non-qualifying groups, plus the unparsed leftovers of sub-rack groups
 *   (leftovers of single-rack groups are reported on the rack's own card
 *   via `unparsedCount` instead).
 */
export function applyCtRackAutoMap(items, opts = {}) {
  const groupIndexes = new Map(); // location -> [item index]
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const loc = (item._ctLocation || '').trim();
    if (!loc) return;
    // Never re-place consumed history or items that already carry a rack signal.
    if (item.addToHistory || item.rackName || item.rackPosition || item.row || item.col) return;
    if (!groupIndexes.has(loc)) groupIndexes.set(loc, []);
    groupIndexes.get(loc).push(i);
  });

  const racks = {};
  const textFallback = [];

  for (const [loc, idxs] of groupIndexes) {
    const analysis = analyzeBinGroups(
      idxs.map((i) => ({ location: loc, bin: items[i]._ctBin || '' })),
      opts
    )[loc];

    if (!analysis?.qualifies) {
      textFallback.push({ location: loc, count: idxs.length });
      continue;
    }

    const isShelf = analysis.inferredBackCols !== undefined;

    for (const p of analysis.placements) {
      const item = items[idxs[p.index]];
      const rackName = p.subRack ? `${loc} ${p.subRack}` : loc;
      const dims = p.subRack
        ? analysis.subRacks?.[p.subRack]
        : { rows: analysis.inferredRows, cols: analysis.inferredCols };

      item.rackName = rackName;
      if (p.row !== undefined) { item.row = p.row; item.col = p.col; }
      if (p.rackPosition !== undefined) item.rackPosition = p.rackPosition;
      if (p.layer !== undefined) { item.layer = p.layer; item.slotInLayer = p.slotInLayer; }
      if (dims?.rows) item.rackRows = dims.rows;
      if (dims?.cols) item.rackCols = dims.cols;
      if (isShelf) item.rackType = 'shelf';

      let entry = racks[rackName];
      if (!entry) {
        entry = racks[rackName] = {
          pattern: analysis.pattern,
          location: loc,
          binCount: analysis.binCount,
          placedCount: 0,
          // Unparsed leftovers can't be attributed to a specific sub-rack,
          // so per-rack counts only make sense when rack === location.
          unparsedCount: p.subRack ? 0 : analysis.unparsed.length,
          rows: dims?.rows,
          cols: dims?.cols,
        };
        if (isShelf) {
          entry.backCols = analysis.inferredBackCols;
          entry.spec = {
            type: 'shelf',
            rows: dims.rows,
            cols: dims.cols,
            typeConfig: { bottlesPerCell: 1, backCols: analysis.inferredBackCols },
          };
        } else if (dims?.rows && dims?.cols) {
          entry.spec = { type: 'grid', rows: dims.rows, cols: dims.cols, typeConfig: {} };
        }
        // sequential: no spec — dimensions come from suggestRackDimensions
        // over the observed maxPosition, exactly like other position imports.
      }
      entry.placedCount += 1;
    }

    // Sub-rack groups report their unparsed leftovers at location level.
    if (analysis.unparsed.length > 0 && analysis.placements.some((p) => p.subRack)) {
      textFallback.push({ location: loc, count: analysis.unparsed.length });
    }
  }

  for (const item of items) {
    delete item._ctLocation;
    delete item._ctBin;
  }

  return { racks, textFallback };
}

// ─── Ploc ────────────────────────────────────────────────────────────────────
//
// Ploc (a French cellar app) does not export one file. It exports a SET that
// only means anything together, joined on the wine's GUID:
//
//   Vins.csv           one row per WINE  — identity, stock count, apogee, value
//   Caves.csv          one row per SLOT  — storage-unit name, row, column
//   Achats-Consos.csv  one row per MOVE  — date, bought/drunk counts, unit price
//   Producteurs.csv    the producer address book — deliberately NOT imported;
//                      it is other people's contact details, and the producer
//                      name we need is already on every wine row.
//
// The file NAMES are French whatever language the app runs in, and users rename
// them anyway (the first sample we were sent arrived as "Wines_sample.csv" and
// "cellars_sample.csv"), so each file is recognised by its COLUMNS instead.
// `IdVin` appears in all three and is the join key — written in mixed case from
// row to row, so it is always compared lower-cased.
//
// What Ploc gives us that a flat CSV cannot:
//   - exact slot positions (name + row + column), so no bin-code guessing
//   - real stock counts per wine, expanded into individual bottles
//   - purchase and consumption history with dates and prices, so a migrating
//     user keeps what they have drunk, not just what they still hold
//
// Not imported: "Degree of alcohol" (the import pipeline has no ABV field),
// "Service temperature", "Tags", "Reference", "IdContact" and the producer
// address book.

/** All three Ploc files carry this column; it is the join key. */
const PLOC_JOIN_KEY = 'idvin';

const PLOC_COLOUR_TO_TYPE = {
  red: 'red', rouge: 'red',
  white: 'white', blanc: 'white',
  'rosé': 'rosé', rose: 'rosé',
  sparkling: 'sparkling', effervescent: 'sparkling', 'pétillant': 'sparkling', petillant: 'sparkling',
  sweet: 'dessert', liquoreux: 'dessert', moelleux: 'dessert',
  fortified: 'fortified', 'fortifié': 'fortified', fortifie: 'fortified', muté: 'fortified', mute: 'fortified',
};

const PLOC_FORMAT_TO_SIZE = {
  bottle: '750ml', bouteille: '750ml',
  magnum: '1500ml',
  half: '375ml', demi: '375ml', 'demi-bouteille': '375ml', 'half bottle': '375ml',
  jeroboam: '3000ml', 'double magnum': '3000ml', 'double-magnum': '3000ml',
  rehoboam: '4500ml', 'réhoboam': '4500ml',
  mathusalem: '6000ml', methuselah: '6000ml', imperial: '6000ml', 'impériale': '6000ml',
  salmanazar: '9000ml',
};

/** Ploc writes a currency SYMBOL, not a code. */
const PLOC_CURRENCY_SYMBOLS = {
  '$': 'USD', 'us$': 'USD', 'usd': 'USD',
  '€': 'EUR', 'eur': 'EUR',
  '£': 'GBP', 'gbp': 'GBP',
  'kr': 'SEK', 'sek': 'SEK',
  'chf': 'CHF', 'fr.': 'CHF',
  '¥': 'JPY', 'jpy': 'JPY',
  'ca$': 'CAD', 'cad': 'CAD',
  'a$': 'AUD', 'aud': 'AUD',
};

/**
 * Which of Ploc's files this is, by its columns — never by its name.
 * @returns {'wines'|'cellars'|'history'|null}
 */
export function detectPlocFile(headers) {
  const h = new Set((headers || []).map((s) => String(s).toLowerCase().trim()));
  if (!h.has(PLOC_JOIN_KEY)) return null;
  if ((h.has('row') && h.has('column')) || (h.has('ligne') && h.has('colonne'))) return 'cellars';
  if ((h.has('purchase') && h.has('consumption')) || (h.has('achat') && h.has('conso'))) return 'history';
  if (h.has('stock') || h.has('producer') || h.has('producteur')) return 'wines';
  return null;
}

/** Case-insensitive column read across the English/French header variants. */
function plocGet(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  // Fall back to a case-insensitive sweep — Ploc's capitalisation varies.
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase().trim()] = row[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** The join key, normalised. Ploc writes the same GUID in mixed case. */
function plocId(row) {
  return plocGet(row, ['IdVin', 'idvin']).toLowerCase();
}

/**
 * "80% Cabernet Sauvignon,18% Merlot,2% Cabernet Franc" → the three varieties.
 * The percentages are Ploc's blend proportions; the registry stores varieties,
 * not proportions, and a grape called "80% Merlot" would never match.
 */
export function parsePlocGrapes(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((g) => g.replace(/^\s*\d+(?:[.,]\d+)?\s*%\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Ploc's "Apogee" is the drinking window, written "2030/2035" (and sometimes as
 * a single year, or with a dash). Maps to the BOTTLE's own window — never to
 * the shared registry's curated maturity, which is a sommelier's judgement.
 */
export function parsePlocApogee(value) {
  const years = String(value || '').match(/\d{4}/g);
  if (!years || years.length === 0) return {};
  const from = parseInt(years[0], 10);
  const to = years[1] ? parseInt(years[1], 10) : undefined;
  if (!Number.isFinite(from)) return {};
  return to && to >= from ? { drinkFrom: from, drinkTo: to } : { drinkFrom: from };
}

/**
 * Build a date parser for one Ploc export.
 *
 * Ploc's raw date format is not documented and varies with the exporting
 * device's locale, so "03/09/2026" is genuinely ambiguous on its own. Rather
 * than guess per row, this reads the WHOLE column first: any row where one
 * component exceeds 12 can only be read one way, and that settles the order for
 * every ambiguous row in the same file. With no such row anywhere it falls back
 * to day-first, which is what a French app writes.
 *
 * Also accepts ISO (unambiguous) and Unix seconds (what Ploc's own database
 * stores), so a hand-made export still lands correctly.
 *
 * @returns {{ parse: (v:*) => string|undefined, dayFirst: boolean, inferred: boolean }}
 *   `parse` returns an ISO yyyy-mm-dd string, or undefined when unreadable.
 */
export function buildPlocDateParser(samples) {
  let dayFirst = true;   // a French app's default
  let inferred = false;

  for (const raw of samples || []) {
    const m = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/.exec(String(raw || '').trim());
    if (!m || m[1].length === 4) continue; // ISO carries its own order
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b <= 12) { dayFirst = true; inferred = true; break; }
    if (b > 12 && a <= 12) { dayFirst = false; inferred = true; break; }
  }

  const iso = (y, mo, d) => {
    if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return undefined;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  return {
    dayFirst,
    inferred,
    parse(value) {
      const s = String(value ?? '').trim();
      if (!s) return undefined;

      // Unix seconds (Ploc's internal storage) — bounded to a sane era so a
      // bare year like "2026" is never read as an epoch.
      if (/^\d{9,11}$/.test(s)) {
        const d = new Date(parseInt(s, 10) * 1000);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
      }

      const isoM = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(s);
      if (isoM) return iso(+isoM[1], +isoM[2], +isoM[3]);

      const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s);
      if (!m) return undefined;
      let year = parseInt(m[3], 10);
      if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      // A component over 12 overrides the file-level order for this row.
      if (a > 12) return iso(year, b, a);
      if (b > 12) return iso(year, a, b);
      return dayFirst ? iso(year, b, a) : iso(year, a, b);
    },
  };
}

/**
 * Ploc's "Note" is the owner's own score, and the file never says on what
 * scale. Infer it from the values present: nothing above 5 is a 5-star scale,
 * nothing above 20 is the French /20, anything higher is /100. The caller
 * surfaces the assumption as a warning so the owner can correct it rather than
 * discover a wrong rating later.
 *
 * @returns {'5'|'20'|'100'|null} null when the file carries no ratings at all
 */
export function inferPlocRatingScale(values) {
  const nums = (values || [])
    .map((v) => parseLocaleNumber(v))
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  const max = Math.max(...nums);
  if (max <= 5) return '5';
  if (max <= 20) return '20';
  return '100';
}

/** "$" → "USD". Returns undefined for anything unrecognised, so the account default applies. */
function plocCurrency(value) {
  const s = String(value || '').trim();
  if (!s) return undefined;
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return PLOC_CURRENCY_SYMBOLS[s.toLowerCase()] || undefined;
}

/**
 * Parse a Ploc export — one, two or three of its files — into master-format
 * items, joined on IdVin.
 *
 * @param {{wines?: string, cellars?: string, history?: string}} texts raw file text
 * @returns {{ items: object[], format: 'ploc', headers: string[],
 *             rackSpecs: object, warnings: object[] }}
 *   `rackSpecs` is the exact geometry of each storage unit, keyed by rack name,
 *   taken from the highest row and column actually used — so the review screen
 *   offers the real shape instead of a guess.
 */
export function parsePlocFiles(texts) {
  const { wines: winesText, cellars: cellarsText, history: historyText } = texts || {};
  const warnings = [];
  if (!winesText) {
    const err = new Error('The wines file is required to import from Ploc');
    err.code = 'ploc-no-wines';
    throw err;
  }

  const rowsOf = (text) => {
    if (!text) return [];
    const cleaned = String(text).replace(/^﻿/, '');
    return parseCSV(cleaned, detectDelimiter(cleaned));
  };

  const wineRows = rowsOf(winesText);
  const slotRows = rowsOf(cellarsText);
  const moveRows = rowsOf(historyText);
  const headers = wineRows.length > 0 ? Object.keys(wineRows[0]) : [];

  // ── Slots, grouped by storage unit ────────────────────────────────────────
  // Ploc calls each unit a "cellar"; it is a physical rack, and its name is the
  // owner's own label ("Column I - Red Burgundy £75-£200"). Empty slots are
  // exported too, and they are useful: they tell us the unit's real shape even
  // where nothing is stored.
  const rackSpecs = {};
  const slotsByWine = new Map(); // wineId -> [{ rackName, row, col }]
  const dims = {};               // rackName -> { rows, cols }
  for (const r of slotRows) {
    const name = plocGet(r, ['Name', 'Nom', 'Cave']);
    const row = parseInt(plocGet(r, ['Row', 'Ligne']), 10);
    const col = parseInt(plocGet(r, ['Column', 'Colonne']), 10);
    if (!name || !Number.isFinite(row) || !Number.isFinite(col)) continue;
    if (!dims[name]) dims[name] = { rows: 0, cols: 0 };
    if (row > dims[name].rows) dims[name].rows = row;
    if (col > dims[name].cols) dims[name].cols = col;
    const id = plocId(r);
    if (!id) continue; // an empty slot: shapes the rack, holds nothing
    if (!slotsByWine.has(id)) slotsByWine.set(id, []);
    slotsByWine.get(id).push({ rackName: name, row, col });
  }
  for (const [name, d] of Object.entries(dims)) {
    // The Rack schema caps a side at 20; a larger unit keeps its bottles but
    // arrives unplaced rather than silently distorted.
    if (d.rows > 20 || d.cols > 20) {
      warnings.push({ code: 'ploc-rack-too-big', rack: name, rows: d.rows, cols: d.cols });
      continue;
    }
    rackSpecs[name] = { type: 'grid', rows: Math.max(1, d.rows), cols: Math.max(1, d.cols), typeConfig: {} };
  }

  // ── Movements ─────────────────────────────────────────────────────────────
  const dateParser = buildPlocDateParser(moveRows.map((r) => plocGet(r, ['Date'])));
  const purchasesByWine = new Map(); // wineId -> [{ date, price, currency, vendor }]
  const consumptionsByWine = new Map(); // wineId -> [{ date, note, occasion }]
  let unmatchedMoves = 0;
  for (const r of moveRows) {
    const id = plocId(r);
    if (!id) continue;
    const date = dateParser.parse(plocGet(r, ['Date']));
    const bought = parseInt(plocGet(r, ['Purchase', 'Achat', 'Achats']), 10) || 0;
    const drunk = parseInt(plocGet(r, ['Consumption', 'Conso', 'Consos']), 10) || 0;
    const price = parseLocaleNumber(plocGet(r, ['Unit price', 'Prix unitaire', 'Prix']));
    const currency = plocCurrency(plocGet(r, ['Currency', 'Devise']));
    const vendor = plocGet(r, ['Vendor', 'Fournisseur', 'Vendeur']);
    const comments = plocGet(r, ['Comments', 'Commentaires', 'Commentaire']);
    const occasion = plocGet(r, ['Opportunity', 'Occasion']);

    if (bought > 0) {
      if (!purchasesByWine.has(id)) purchasesByWine.set(id, []);
      for (let i = 0; i < bought; i++) {
        purchasesByWine.get(id).push({ date, price: price > 0 ? price : undefined, currency, vendor });
      }
    }
    if (drunk > 0) {
      if (!consumptionsByWine.has(id)) consumptionsByWine.set(id, []);
      for (let i = 0; i < drunk; i++) {
        consumptionsByWine.get(id).push({ date, note: comments, occasion });
      }
    }
  }

  // ── Wines → bottles ───────────────────────────────────────────────────────
  const ratingScale = inferPlocRatingScale(wineRows.map((r) => plocGet(r, ['Note', 'Notation'])));
  if (ratingScale) warnings.push({ code: 'ploc-rating-scale', scale: ratingScale });
  if (moveRows.length > 0 && dateParser.inferred === false) {
    warnings.push({ code: 'ploc-date-order-assumed', dayFirst: dateParser.dayFirst });
  }

  const items = [];
  const seenWineIds = new Set();
  let placedCount = 0;
  let historyCount = 0;

  for (const r of wineRows) {
    const wineName = plocGet(r, ['Wine name', 'Wine Name', 'Nom du vin', 'Vin']);
    const producer = plocGet(r, ['Producer', 'Producteur', 'Domaine']);
    if (!wineName && !producer) continue;
    const id = plocId(r);
    if (id) seenWineIds.add(id);

    const colour = plocGet(r, ['Color', 'Colour', 'Couleur']).toLowerCase();
    const rawRating = parseLocaleNumber(plocGet(r, ['Note', 'Notation']));
    const estimate = parseLocaleNumber(plocGet(r, ['Estimate', 'Estimation', 'Valeur']));

    const base = {
      wineName,
      producer: producer || undefined,
      vintage: plocGet(r, ['Vintage', 'Millésime', 'Millesime']) || 'NV',
      type: PLOC_COLOUR_TO_TYPE[colour] || undefined,
      grapes: parsePlocGrapes(plocGet(r, ['Grapes', 'Cépages', 'Cepages', 'Cépage'])),
      country: plocGet(r, ['Country', 'Pays']) || undefined,
      region: plocGet(r, ['Region', 'Région']) || undefined,
      appellation: plocGet(r, ['Appellation']) || undefined,
      classification: plocGet(r, ['Classification', 'Classement']) || undefined,
      bottleSize: PLOC_FORMAT_TO_SIZE[plocGet(r, ['Bottle format', 'Format', 'Contenant']).toLowerCase()] || undefined,
      notes: plocGet(r, ['Comments', 'Commentaires', 'Commentaire']) || undefined,
      ...parsePlocApogee(plocGet(r, ['Apogee', 'Apogée'])),
      ...(ratingScale && rawRating > 0 ? { rating: rawRating, ratingScale } : {}),
    };

    const stock = Math.max(0, parseInt(plocGet(r, ['Stock']), 10) || 0);
    const consumptions = (id && consumptionsByWine.get(id)) || [];
    const purchases = ((id && purchasesByWine.get(id)) || [])
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    // Oldest bottles are drunk first, so the earliest purchases belong to the
    // consumed bottles and whatever remains belongs to what is still in the
    // cellar. When the two sides disagree — a stock count that predates the
    // movement log, say — the wines file wins on how many bottles exist and the
    // history only ever supplies dates and prices.
    const consumedPurchases = purchases.slice(0, consumptions.length);
    let activePurchases = purchases.slice(consumptions.length);
    if (activePurchases.length > stock) activePurchases = activePurchases.slice(-stock);

    consumptions
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .forEach((c, i) => {
        const p = consumedPurchases[i];
        items.push({
          ...base,
          grapes: [...base.grapes],
          quantity: 1,
          addToHistory: true,
          consumedReason: 'drank',
          ...(c.date ? { consumedAt: c.date } : {}),
          ...(c.note ? { consumedNote: c.note } : {}),
          ...(c.occasion ? { occasion: c.occasion } : {}),
          ...(p?.date ? { purchaseDate: p.date, dateAdded: p.date } : {}),
          ...(p?.price ? { price: p.price } : {}),
          ...(p?.currency ? { currency: p.currency } : {}),
          ...(p?.vendor ? { purchaseLocation: p.vendor } : {}),
        });
        historyCount += 1;
      });

    const slots = (id && slotsByWine.get(id)) || [];
    if (slots.length > stock) {
      warnings.push({ code: 'ploc-extra-slots', wine: wineName, slots: slots.length, stock });
    }
    for (let i = 0; i < stock; i++) {
      const slot = slots[i];
      const p = activePurchases[i];
      if (slot) placedCount += 1;
      items.push({
        ...base,
        grapes: [...base.grapes],
        quantity: 1,
        ...(slot ? { rackName: slot.rackName, row: slot.row, col: slot.col } : {}),
        ...(p?.date ? { purchaseDate: p.date, dateAdded: p.date } : {}),
        // A recorded purchase price is what the bottle actually cost; the
        // wines file's "Estimate" is today's value, and only fills the gap.
        ...(p?.price ? { price: p.price } : estimate > 0 ? { price: estimate } : {}),
        ...(p?.currency ? { currency: p.currency } : {}),
        ...(p?.vendor ? { purchaseLocation: p.vendor } : {}),
      });
    }
  }

  for (const id of [...purchasesByWine.keys(), ...consumptionsByWine.keys()]) {
    if (!seenWineIds.has(id)) unmatchedMoves += 1;
  }
  if (unmatchedMoves > 0) warnings.push({ code: 'ploc-unmatched-history', count: unmatchedMoves });
  if (slotRows.length === 0) warnings.push({ code: 'ploc-no-cellars' });
  if (moveRows.length === 0) warnings.push({ code: 'ploc-no-history' });
  if (placedCount > 0) warnings.push({ code: 'ploc-placed', count: placedCount, racks: Object.keys(rackSpecs).length });
  if (historyCount > 0) warnings.push({ code: 'ploc-history', count: historyCount });

  return { items, format: 'ploc', headers, rackSpecs, warnings };
}


/**
 * Main entry: parse a file and return mapped items in master format.
 *
 * @param {string} text - Raw CSV/TSV text content
 * @param {string} [forceFormat] - Force a specific format ('vivino' | 'cellartracker' | 'generic')
 * @returns {{ items: object[], format: string, headers: string[],
 *             ctTable?: string, warnings?: object[] }}
 *   `ctTable` identifies which CellarTracker table was fingerprinted
 *   ('list'|'inventory'|'bottles'|'consumed'|'purchase'|'pending').
 *   `vivinoScanHistory` is true when a Vivino file matches the scan-history
 *   fingerprint (see isVivinoScanHistory) \u2014 the UI then offers importing the
 *   rows as drinking history instead of active bottles.
 *   `warnings` are non-blocking notices:
 *     { code: 'ct-truncated' }                       \u2014 exactly 25 data rows
 *       (CellarTracker's "Only wines on this page" default page size)
 *     { code: 'ct-pending-skipped', count, wines }   \u2014 undelivered bottles
 *       skipped (Cellarion has no on-order state)
 *     { code: 'no-identity-skipped', count }         \u2014 rows with neither a
 *       wine name nor a producer skipped (e.g. failed Vivino scans)
 * @throws Error with code 'ct-error-page' for HTML error pages, or
 *   'ct-availability' for CT's Availability statistics table.
 */
export function parseAndMap(text, forceFormat, opts = {}) {
  // Strip BOM
  const cleaned = text.replace(/^\uFEFF/, '');

  // HTML instead of data = an error page (typically CellarTracker's
  // "not logged in" response saved as .csv/.tsv). Fail fast and clearly.
  throwIfHtmlErrorPage(cleaned);

  // Oeno's real export has a distinctive two-section structure that single-
  // row header detection can't pick up; try the Oeno-export parser first.
  if (!forceFormat || forceFormat === 'oeno-export') {
    const lines = cleaned.split(/\r?\n/);
    if (detectOenoExportBoundary(lines) !== -1) {
      const parsed = parseOenoExport(text);
      if (parsed) return parsed;
    }
  }

  const delimiter = detectDelimiter(cleaned);
  const rows = parseCSV(cleaned, delimiter);

  if (rows.length === 0) {
    return { items: [], format: 'unknown', headers: [] };
  }

  const headers = Object.keys(rows[0]);
  const format = forceFormat || detectFormat(headers);

  let ctTable = null;
  if (format === 'cellartracker') {
    ctTable = detectCellarTrackerTable(headers);
    if (ctTable === 'availability') {
      // Statistics table (per-critic drink windows), not a cellar export.
      const err = new Error('CellarTracker Availability is a statistics table, not a cellar export');
      err.code = 'ct-availability';
      throw err;
    }
    // Purchase and Pending share one schema; a file whose rows are ALL
    // undelivered is the Pending table (or a purchase export of futures).
    if (ctTable === 'purchase' &&
        rows.every((r) => (r.Delivered || '').trim().toLowerCase() === 'false')) {
      ctTable = 'pending';
    }
  }

  const mapper = format === 'cellarion'
    ? mapCellarionRow
    : format === 'vivino'
      ? mapVivinoRow
    : format === 'cellartracker'
      ? (CT_TABLE_MAPPERS[ctTable] || mapCellarTrackerRow)
      : mapGenericRow;

  // Map rows and expand quantity > 1 into individual items
  const items = [];
  const ctPendingSkipped = { count: 0, wines: [] };
  let noIdentitySkipped = 0;
  for (const row of rows) {
    const mapped = mapper(row);

    // Pending (undelivered) CT bottles: Cellarion has no on-order state \u2014
    // skip them but keep an honest count for the review-step warning.
    if (mapped._ctPending) {
      ctPendingSkipped.count += mapped._ctPendingCount || 1;
      if (mapped.wineName && !ctPendingSkipped.wines.includes(mapped.wineName)) {
        ctPendingSkipped.wines.push(mapped.wineName);
      }
      continue;
    }

    // Normalise dates (mirror parseJSON)
    if (mapped.purchaseDate) mapped.purchaseDate = tryParseDate(mapped.purchaseDate);
    if (mapped.consumedAt)   mapped.consumedAt   = tryParseDate(mapped.consumedAt);
    if (mapped.dateAdded)    mapped.dateAdded    = tryParseDate(mapped.dateAdded);

    // Skip rows with no wine name \u2014 counted so the upload step can say so
    // instead of the rows just vanishing (Vivino scan history routinely
    // contains label-image-only rows for failed scans). This used to be
    // `!wineName && !producer`, an AND, so a producer-only row slipped
    // through \u2014 and the import then filed a WineRequest with the PRODUCER as
    // the wine's name. One broken generic-CSV export did that 131 times in a
    // single import ("Hewitson \u2014 Hewitson", 2026-08-28): a whole cellar
    // parked on junk requests no curator can resolve, because 250 distinct
    // cuv\u00e9es sat behind one producer string. The module's own master-format
    // doc has always said wineName is required; now the gate agrees.
    // Name-only rows (no producer) still pass \u2014 those resolve fine.
    if (!mapped.wineName) { noIdentitySkipped++; continue; }

    // `?? 1` not `|| 1`: CT List rows can legitimately carry quantity 0
    // (fully pending wines) and must expand to zero items. All other
    // mappers clamp quantity to >= 1 themselves.
    const qty = mapped.quantity ?? 1;
    delete mapped.quantity;

    for (let q = 0; q < qty; q++) {
      items.push({ ...mapped });
    }
  }

  // CellarTracker Location/Bin → rack auto-map. Runs after quantity
  // expansion so groups reflect physical bottle counts; also strips the
  // transient _ctLocation/_ctBin markers from every item.
  let ctRackAutoMap = null;
  if (format === 'cellartracker') {
    // opts.ctBinOrder: 'row-col' (default) | 'col-row' — the user's declaration
    // of how their bins are typed (support ticket 2026-09-05).
    const autoMap = applyCtRackAutoMap(items, { binOrder: opts.ctBinOrder });
    if (Object.keys(autoMap.racks).length > 0 || autoMap.textFallback.length > 0) {
      ctRackAutoMap = autoMap;
    }
  }

  const warnings = [];
  // CellarTracker's browser export defaults to "Only wines on this page" =
  // 25 rows. A file with EXACTLY 25 data rows is very likely truncated.
  if (format === 'cellartracker' && rows.length === 25) {
    warnings.push({ code: 'ct-truncated' });
  }
  if (ctPendingSkipped.count > 0) {
    warnings.push({
      code: 'ct-pending-skipped',
      count: ctPendingSkipped.count,
      wines: ctPendingSkipped.wines,
    });
  }
  if (noIdentitySkipped > 0) {
    warnings.push({ code: 'no-identity-skipped', count: noIdentitySkipped });
  }

  return {
    items,
    format,
    headers,
    ...(ctTable ? { ctTable } : {}),
    ...(format === 'vivino' && isVivinoScanHistory(headers) ? { vivinoScanHistory: true } : {}),
    ...(ctRackAutoMap ? { ctRackAutoMap } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Pick a sensible default rack configuration for the picker based on the
 * detected source format and per-rack stats. Format-specific knowledge
 * lives here so the page component doesn't have to know about it.
 *
 * Currently:
 *   - oeno-export: rack defaults come from the cabinet metadata inside the
 *     CSV itself (cabinet brand/model → shelf layout). Per-rack overrides
 *     are written directly during parsing, so this function returns a
 *     conservative shelf fallback for any rack that slips through.
 *   - cellartracker: racks derived from Location/Bin auto-mapping carry the
 *     pattern-detected geometry in info.ctRackSpec (set from
 *     ctRackAutoMap.racks[name].spec); sequential-bin racks have no spec and
 *     fall through to the maxPosition-based grid sizing below.
 *   - everything else: Grid with rows/cols sized to fit the data. No
 *     auto-inferred multi-bottle stacking; users opt in via the picker.
 */
export function getDefaultRackConfig(format, info) {
  if (info.rackSpec) {
    // Geometry the source file stated outright (Ploc gives every unit's real
    // row/column extent), rather than one inferred from the bottles.
    return info.rackSpec;
  }
  if (info.ctRackSpec) {
    // Geometry detected from the CellarTracker bin-code pattern.
    return info.ctRackSpec;
  }
  if (format === 'oeno-export' && info.oenoRackSpec) {
    // Cabinet/column-specific spec set during oeno-export parsing.
    return info.oenoRackSpec;
  }
  const required = Math.max(info.maxPosition || 0, info.count || 0);
  return { type: 'grid', ...suggestRackDimensions(required), typeConfig: {} };
}

/**
 * Format-specific default for the slot-1 anchor.
 *   - oeno-export: shelf 1 is at the bottom of the cabinet (Oeno convention)
 *   - everything else: top-left (most apps)
 */
export function getDefaultAnchor(format) {
  return format === 'oeno-export' ? 'bottom-left' : 'top-left';
}
