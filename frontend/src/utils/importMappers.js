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
 */

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
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
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

  // Split a line respecting the delimiter
  const splitLine = (line) => {
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

function mapWineType(typeStr) {
  if (!typeStr) return 'red';
  const t = typeStr.toLowerCase().trim();
  if (t.includes('red')) return 'red';
  if (t.includes('white')) return 'white';
  if (t.includes('rosé') || t.includes('rose')) return 'rosé';
  if (t.includes('sparkling') || t.includes('champagne') || t.includes('cava') || t.includes('prosecco')) return 'sparkling';
  if (t.includes('dessert') || t.includes('sweet') || t.includes('ice wine')) return 'dessert';
  if (t.includes('fortified') || t.includes('port') || t.includes('sherry') || t.includes('madeira')) return 'fortified';
  return 'red';
}

function mapVivinoRow(row) {
  // Vivino CSV columns vary but common ones:
  // "Wine name", "Winery", "Vintage", "Country", "Region", "Appellation",
  // "Wine type", "Price", "Currency", "Rating", "Note", "Quantity",
  // "Purchase date", "Store name", "Bottle size"
  const get = makeGetter(row);

  const rating = parseLocaleNumber(get(['Rating', 'My Rating', 'rating']));
  const price = parseLocaleNumber(get(['Price', 'price', 'Purchase Price']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'Count']), 10);

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
    notes: get(['Note', 'Notes', 'note', 'notes', 'Tasting Note', 'Review']),
    rating: isNaN(rating) ? undefined : rating,
    ratingScale: inferRatingScale(rating),
    location: get(['Location', 'location', 'Bin', 'bin']),
    ...mapRackFields(get),
  };
}

// ── CellarTracker Mapper ────────────────────────────────────────────────────

function mapCellarTrackerRow(row) {
  const get = makeGetter(row);

  // CellarTracker uses "Wine" which often includes producer in the name
  let wineName = get(['Wine', 'wine', 'WineName']);
  let producer = get(['Producer', 'producer']);

  // If producer is empty, fall back to the first word of the Wine field.
  // CellarTracker's "Wine" column usually leads with the producer
  // ("Producer Wine Name"), so this is a crude best-effort guess — wrong
  // for multi-word producers ("Château Margaux" → "Château"), but it gives
  // the import matcher something rather than nothing.
  if (!producer && wineName) {
    const parts = wineName.split(/\s+/);
    if (parts.length > 2) {
      producer = parts[0];
    }
  }

  const price = parseLocaleNumber(get(['Price', 'price', 'Cost']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'Count']), 10);
  const ctRating = parseLocaleNumber(get(['MyCTRating', 'CT Rating', 'My Rating', 'Rating']));

  return {
    wineName: get(['Wine', 'wine', 'WineName']),
    producer,
    vintage: get(['Vintage', 'vintage', 'Year']) || 'NV',
    country: get(['Country', 'country', 'Locale']),
    region: get(['Region', 'region', 'Sub-Region']),
    appellation: get(['Appellation', 'appellation', 'SubRegion']),
    type: mapWineType(get(['Type', 'type', 'Color', 'Colour', 'Category'])),
    price: isNaN(price) ? undefined : price,
    currency: get(['Currency', 'currency']) || undefined,
    bottleSize: get(['Size', 'size', 'Bottle Size', 'BottleSize']) || '750ml',
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: get(['PurchaseDate', 'Purchase Date', 'Date Purchased']),
    purchaseLocation: get(['Store', 'store', 'StoreName', 'Purchase Location', 'Vendor']),
    notes: get(['Notes', 'notes', 'MyNotes', 'Tasting Notes', 'Review']),
    rating: isNaN(ctRating) ? undefined : ctRating,
    ratingScale: inferRatingScale(ctRating),
    location: get(['Location', 'location', 'Bin', 'bin']),
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

  return {
    wineName: get(['Wine', 'wine', 'Wine Name', 'WineName', 'Name', 'name']),
    producer: get(['Producer', 'producer', 'Winery', 'winery', 'Maker', 'maker']),
    vintage: get(['Vintage', 'vintage', 'Year', 'year']) || 'NV',
    country: get(['Country', 'country']),
    region: get(['Region', 'region']),
    appellation: get(['Appellation', 'appellation', 'Sub-Region', 'SubRegion']),
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
 */
function mapCellarionRow(row) {
  const str = (key) => (row[key] || '').trim();
  const num = (key) => { const n = parseLocaleNumber(row[key]); return isNaN(n) ? undefined : n; };
  const int = (key) => { const n = parseInt(row[key], 10); return isNaN(n) ? undefined : n; };

  return {
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
 *   - Cellarion export object: { cellarName, exportedAt, bottles: [...] }
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

  const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bottles) ? parsed.bottles : null);
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
      purchaseDate: (cells[idx.purchase] || '').trim() || undefined,
    };

    if (consumedAt) {
      baseItem.addToHistory = true;
      baseItem.consumedAt = consumedAt;
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
  for (const [, cab] of cabinetById) {
    const totalColumns = cab.columns.size;
    for (const [columnIndex, col] of cab.columns) {
      const rackName = rackNameFor(cab.label, columnIndex, totalColumns);
      oenoRackSpecs[rackName] = {
        type: 'shelf',
        rows: Math.min(20, col.maxShelf),
        cols: 6,
        typeConfig: { bottlesPerCell: 1, backCols: 5 },
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

/**
 * Main entry: parse a file and return mapped items in master format.
 *
 * @param {string} text - Raw CSV/TSV text content
 * @param {string} [forceFormat] - Force a specific format ('vivino' | 'cellartracker' | 'generic')
 * @returns {{ items: object[], format: string, headers: string[] }}
 */
export function parseAndMap(text, forceFormat) {
  // Strip BOM
  const cleaned = text.replace(/^\uFEFF/, '');

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

  const mapper = format === 'cellarion'
    ? mapCellarionRow
    : format === 'vivino'
      ? mapVivinoRow
    : format === 'cellartracker'
      ? mapCellarTrackerRow
      : mapGenericRow;

  // Map rows and expand quantity > 1 into individual items
  const items = [];
  for (const row of rows) {
    const mapped = mapper(row);

    // Fix dates
    if (mapped.purchaseDate) mapped.purchaseDate = tryParseDate(mapped.purchaseDate);

    // Skip rows with no wine name and no producer
    if (!mapped.wineName && !mapped.producer) continue;

    const qty = mapped.quantity || 1;
    delete mapped.quantity;

    for (let q = 0; q < qty; q++) {
      items.push({ ...mapped });
    }
  }

  return { items, format, headers };
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
 *   - everything else: Grid with rows/cols sized to fit the data. No
 *     auto-inferred multi-bottle stacking; users opt in via the picker.
 */
export function getDefaultRackConfig(format, info) {
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
