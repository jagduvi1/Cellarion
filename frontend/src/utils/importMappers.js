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
 *   rackType      - Optional rack type (grid|shelf|hex|triangle|stack|x-rack|cube|cabinet)
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
import {
  parseLocaleNumber, makeGetter, firstPrice, priceFromCurrencyHeader, looksLikePriceHeader,
  inferRatingScale, mapRackFields, looksNonWine, mapWineType, vintageOrNV, tryParseDate,
} from './importFields';
import { parseCSV, throwIfHtmlErrorPage, detectDelimiter } from './importCsv';
import {
  guessProducerFromWineName, stripProducerPrefix, splitClassificationFromName,
  stripAppellationPrefixFromName,
} from './importNames';
import { parseCombinedRackLocation } from './importRacks';
import { detectOenoExportBoundary, parseOenoExport } from './importOeno';
export { detectOenoExportBoundary, parseOenoExport } from './importOeno';
export {
  parseCombinedRackLocation, suggestRackDimensions, summariseRacks, getDefaultRackConfig,
  getDefaultAnchor,
} from './importRacks';
export {
  guessProducerFromWineName, stripProducerPrefix, splitClassificationFromName,
  stripAppellationPrefixFromName,
} from './importNames';
export { decodeCharRefs, parseCSV, decodeImportBuffer, detectDelimiter } from './importCsv';
export {
  parseLocaleNumber, normHeader, PRICE_HEADERS, priceFromCurrencyHeader, looksLikePriceHeader,
  looksNonWine,
} from './importFields';

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
    ...vintageOrNV(get(['Vintage', 'vintage', 'Year', 'year'])),
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
    ...vintageOrNV(ctVintage(get(['Vintage']))),
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
// Items flagged `_ctPending` are pending (undelivered) purchases. parseAndMap
// imports them as bottles ON ORDER (`onOrder: true`): kept out of the cellar
// until the user marks them as arrived, and reported in a warning.

/** List: one row per WINE with Quantity (+ Pending). Quantity expands to N
 *  bottles in the cellar; Pending adds that many bottles on order. */
function mapCtListRow(row) {
  const get = makeGetter(row);
  const qty = parseInt(get(['Quantity']), 10);
  const pending = parseInt(get(['Pending']), 10) || 0;
  const item = {
    ...ctCommonFields(get),
    ...ctMoney(get),
    quantity: Number.isNaN(qty) ? 1 : qty,
  };
  if (pending > 0) {
    if (item.quantity === 0) {
      item._ctPending = true;
      item._ctPendingCount = pending;
    } else {
      // Some in the cellar, some still on their way: both come across.
      item._ctAlsoPending = pending;
    }
  }
  return item;
}

/** Inventory: one row per physical in-cellar bottle (plus pending rows,
 *  marked Location "(pending)", which come in on order). */
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
 *  BottleState: -1 = pending (on order), 0 = consumed (history), 1 = in cellar. */
function mapCtBottlesRow(row) {
  const get = makeGetter(row);
  const common = ctCommonFields(get, { sizeKeys: ['BottleSize', 'Size'] });
  const state = get(['BottleState']).trim();
  if (state === '-1') {
    return {
      ...common,
      ...ctMoney(get, { priceKeys: ['BottleCost'], currencyKeys: ['BottleCostCurrency'] }),
      quantity: 1,
      purchaseDate: ctDate(get(['PurchaseDate'])),
      purchaseLocation: ctClean(get(['Store', 'StoreName'])),
      _ctPending: true,
    };
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
 *  is relabeled 'pending' by parseAndMap. A row not delivered yet comes in
 *  on order. */
function mapCtPurchaseRow(row) {
  const get = makeGetter(row);
  const qty = parseInt(get(['Quantity']), 10);
  const item = {
    ...ctCommonFields(get),
    ...ctMoney(get),
    quantity: Number.isNaN(qty) || qty < 1 ? 1 : qty,
    purchaseDate: ctDate(get(['PurchaseDate'])),
    purchaseLocation: ctClean(get(['StoreName', 'Store'])),
  };
  if ((get(['Delivered']) || '').trim().toLowerCase() === 'false') item._ctPending = true;
  return item;
}

const CT_TABLE_MAPPERS = {
  list: mapCtListRow,
  inventory: mapCtInventoryRow,
  bottles: mapCtBottlesRow,
  consumed: mapCtConsumedRow,
  purchase: mapCtPurchaseRow,
  pending: mapCtPurchaseRow,
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
    ...vintageOrNV(ctVintage(get(['Vintage', 'vintage', 'Year']))),
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

  // Any of the usual price names; failing that, a price column that names its
  // currency in the header ("Price (AUD)") — which then also gives the
  // currency when the file has no Currency column.
  const priceText = firstPrice(get);
  const headerPrice = priceText ? null : priceFromCurrencyHeader(row);
  const price = parseLocaleNumber(priceText || headerPrice?.value);
  const rating = parseLocaleNumber(get(['Rating', 'rating', 'Score', 'score']));
  const qty = parseInt(get(['Quantity', 'quantity', 'Qty', 'qty', 'Count', 'count']), 10);

  // Combined rack+position columns like Oeno's "Rack_Location" = "M2-11"
  const combined = get(['Rack_Location', 'Rack Location', 'RackLocation', 'Bin Location', 'BinLocation']);
  const parsedRack = parseCombinedRackLocation(combined);
  const rackFields = mapRackFields(get);

  const producer = get(['Producer', 'producer', 'Winery', 'winery', 'Maker', 'maker']);
  const region = get(['Region', 'region']);
  const appellation = get(['Appellation', 'appellation', 'Sub-Region', 'SubRegion']);
  // Same tier-in-name guard as the CT path — plus an
  // explicit Classification column, which some hand-written files carry.
  const { wineName, classification } = splitClassificationFromName(
    get(['Wine', 'wine', 'Wine Name', 'WineName', 'Name', 'name']),
    { producer, appellation, region });

  return {
    wineName,
    producer,
    classification: classification || get(['Classification', 'classification']) || undefined,
    ...vintageOrNV(get(['Vintage', 'vintage', 'Year', 'year'])),
    country: get(['Country', 'country']),
    region,
    appellation,
    type: mapWineType(get(['Type', 'type', 'Color', 'Colour', 'Category', 'category'])),
    price: isNaN(price) ? undefined : price,
    currency: get(['Currency', 'currency']) || headerPrice?.currency || undefined,
    bottleSize: normalizeBottleSize(get(['Size', 'size', 'Bottle Size', 'BottleSize'])) || '750ml',
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
    ...vintageOrNV(str('vintage')),
    country: str('country'),
    region: str('region'),
    appellation: str('appellation'),
    type: mapWineType(str('type')),
    // The export writes category 'other' for a drink that is not wine: it
    // re-imports as Other, never as an untyped wine (release audit 2026-10-28).
    nonWineHint: str('category').toLowerCase() === 'other' || undefined,
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
    // Never re-place consumed history, bottles still on order, or items that already carry a rack signal.
    if (item.addToHistory || item.onOrder || item.rackName || item.rackPosition || item.row || item.col) return;
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
      ...vintageOrNV(plocGet(r, ['Vintage', 'Millésime', 'Millesime'])),
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
 *     { code: 'ct-pending-on-order', count, wines }  \u2014 undelivered bottles
 *       imported ON ORDER (onOrder: true), kept out of the cellar until arrival
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
      const parsed = parseOenoExport(cleaned);
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
  const ctPendingOnOrder = { count: 0, wines: [] };
  const notePending = (wineName, count) => {
    ctPendingOnOrder.count += count;
    if (wineName && !ctPendingOnOrder.wines.includes(wineName)) ctPendingOnOrder.wines.push(wineName);
  };
  let noIdentitySkipped = 0;
  for (const row of rows) {
    const mapped = mapper(row);

    // Pending (undelivered) CT bottles come in ON ORDER: kept out of the
    // cellar until marked as arrived. Not in a rack yet, so no placement.
    if (mapped._ctPending) {
      if (mapped._ctPendingCount) mapped.quantity = mapped._ctPendingCount;
      mapped.onOrder = true;
      delete mapped._ctPending;
      delete mapped._ctPendingCount;
      delete mapped._ctLocation;
      delete mapped._ctBin;
      // Not in the cellar yet, so in no place of it (CT writes "(pending)").
      delete mapped.location;
    }
    // A List row with bottles in the cellar AND more pending: the pending
    // ones are pushed as on-order copies after the in-cellar expansion.
    const alsoPending = mapped._ctAlsoPending || 0;
    delete mapped._ctAlsoPending;

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
    // Counted only once the row is known to import (a nameless one is skipped).
    if (mapped.onOrder) notePending(mapped.wineName, mapped.quantity ?? 1);

    // `?? 1` not `|| 1`: CT List rows can legitimately carry quantity 0
    // (fully pending wines) and must expand to zero items. All other
    // mappers clamp quantity to >= 1 themselves.
    const qty = mapped.quantity ?? 1;
    delete mapped.quantity;

    for (let q = 0; q < qty; q++) {
      items.push({ ...mapped });
    }
    if (alsoPending > 0) {
      notePending(mapped.wineName, alsoPending);
      const { _ctLocation, _ctBin, location, ...rest } = mapped;
      for (let q = 0; q < alsoPending; q++) {
        items.push({ ...rest, onOrder: true });
      }
    }
  }

  // CellarTracker Location/Bin → rack auto-map. Runs after quantity
  // expansion so groups reflect physical bottle counts; also strips the
  // transient _ctLocation/_ctBin markers from every item.
  let ctRackAutoMap = null;
  if (format === 'cellartracker') {
    // opts.ctBinOrder: 'row-col' (default) | 'col-row' — the user's declaration
    // of how their bins are typed.
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
  if (ctPendingOnOrder.count > 0) {
    warnings.push({
      code: 'ct-pending-on-order',
      count: ctPendingOnOrder.count,
      wines: ctPendingOnOrder.wines,
    });
  }
  if (noIdentitySkipped > 0) {
    warnings.push({ code: 'no-identity-skipped', count: noIdentitySkipped });
  }
  const vintageMissing = items.filter((it) => it.vintageMissing).length;
  if (vintageMissing > 0) {
    warnings.push({ code: 'vintage-missing', count: vintageMissing });
  }
  // A filled-in column that reads like a price, and not one bottle got a
  // price from it: its name was not one we know, or its values did not read
  // as numbers. Said out loud instead of importing every bottle without its
  // price in silence (forum feedback 2026-10-12).
  if (items.length > 0 && !items.some((it) => it.price != null)) {
    // "0" is how CellarTracker writes "no price entered" — not a price left unread.
    const filled = (v) => { const s = v == null ? '' : String(v).trim(); return s !== '' && parseLocaleNumber(s) !== 0; };
    const priceColumn = headers.find((h) => looksLikePriceHeader(h) && rows.some((r) => filled(r[h])));
    if (priceColumn) warnings.push({ code: 'price-not-read', column: String(priceColumn).trim() });
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
