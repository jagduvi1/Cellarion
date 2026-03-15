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
 */

/**
 * Parse CSV text into an array of row objects.
 * Handles quoted fields, embedded commas, and newlines within quotes.
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
 * Returns: 'vivino' | 'cellartracker' | 'generic'
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
 * Auto-detect delimiter from first line of CSV.
 */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0];
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes(';')) return ';';
  return ',';
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
  const get = (keys) => {
    for (const k of keys) {
      const val = row[k] || row[k.toLowerCase()];
      if (val) return val.trim();
    }
    return '';
  };

  const rating = parseFloat(get(['Rating', 'My Rating', 'rating']));
  const price = parseFloat(get(['Price', 'price', 'Purchase Price']));
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
    ratingScale: rating > 5 ? '100' : '5',
    location: get(['Location', 'location', 'Bin', 'bin']),
    rackName: get(['Rack', 'rack', 'Rack Name', 'rackName']) || undefined,
    rackPosition: parseInt(get(['Rack Position', 'rackPosition', 'Position', 'Slot']), 10) || undefined,
  };
}

// ── CellarTracker Mapper ────────────────────────────────────────────────────

function mapCellarTrackerRow(row) {
  const get = (keys) => {
    for (const k of keys) {
      const val = row[k] || row[k.toLowerCase()];
      if (val) return val.trim();
    }
    return '';
  };

  // CellarTracker uses "Wine" which often includes producer in the name
  let wineName = get(['Wine', 'wine', 'WineName']);
  let producer = get(['Producer', 'producer']);

  // If producer is empty, try to extract from Wine field
  // CellarTracker format often: "Producer Wine Name Vintage"
  if (!producer && wineName) {
    // Try to split on common patterns
    const parts = wineName.split(/\s+/);
    if (parts.length > 2) {
      // Heuristic: first word(s) before the wine type keywords
      producer = parts[0];
    }
  }

  const price = parseFloat(get(['Price', 'price', 'Cost']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'Count']), 10);
  const ctRating = parseFloat(get(['MyCTRating', 'CT Rating', 'My Rating', 'Rating']));

  return {
    wineName: get(['Wine', 'wine', 'WineName']),
    producer: producer || get(['Producer', 'producer']),
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
    ratingScale: ctRating > 20 ? '100' : ctRating > 5 ? '20' : '5',
    location: get(['Location', 'location', 'Bin', 'bin']),
    rackName: get(['Rack', 'rack', 'Rack Name', 'rackName']) || undefined,
    rackPosition: parseInt(get(['Rack Position', 'rackPosition', 'Position', 'Slot']), 10) || undefined,
  };
}

// ── Generic CSV Mapper ──────────────────────────────────────────────────────

function mapGenericRow(row) {
  const get = (keys) => {
    for (const k of keys) {
      const val = row[k] || row[k.toLowerCase()];
      if (val) return val.trim();
    }
    return '';
  };

  const price = parseFloat(get(['Price', 'price', 'Cost', 'cost']));
  const rating = parseFloat(get(['Rating', 'rating', 'Score', 'score']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'qty', 'Count', 'count']), 10);

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
    bottleSize: get(['Size', 'size', 'Bottle Size', 'BottleSize']) || '750ml',
    quantity: isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: get(['Purchase Date', 'PurchaseDate', 'Date', 'date']),
    purchaseLocation: get(['Store', 'store', 'Purchase Location', 'Vendor', 'vendor']),
    notes: get(['Notes', 'notes', 'Note', 'note', 'Comments', 'comments']),
    rating: isNaN(rating) ? undefined : rating,
    ratingScale: rating > 20 ? '100' : rating > 5 ? '20' : '5',
    location: get(['Location', 'location', 'Bin', 'bin']),
    rackName: get(['Rack', 'rack', 'Rack Name', 'rackName']) || undefined,
    rackPosition: parseInt(get(['Rack Position', 'rackPosition', 'Position', 'Slot']), 10) || undefined,
  };
}

// ── Cellarion CSV Mapper ─────────────────────────────────────────────────────

/**
 * Map a row from Cellarion's own CSV export.
 * Headers are already in master format (camelCase), so pass through directly.
 */
function mapCellarionRow(row) {
  const str = (key) => (row[key] || '').trim();
  const num = (key) => { const n = parseFloat(row[key]); return isNaN(n) ? undefined : n; };
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
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
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
