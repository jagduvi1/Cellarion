import { normalizeBottleSize } from '../config/bottleSizes';
import { analyzeBinGroups } from './binCodeParser';
import {
  parseLocaleNumber, makeGetter, inferRatingScale, mapRackFields, looksNonWine, mapWineType,
  vintageOrNV, tryParseDate,
} from './importFields';
import {
  guessProducerFromWineName, stripProducerPrefix, splitClassificationFromName,
  stripAppellationPrefixFromName,
} from './importNames';

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
//
// utils/importMappers.js re-exports the public names.

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
// ⚠️ `spirits` and `whisky` are never 'fortified'. They are not fortified
// WINE: a CT cellar routinely holds whisky, and calling it a fortified wine
// would put a spirit into the wine registry wearing a wine type. They return
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

export const CT_TABLE_MAPPERS = {
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
export function mapCellarTrackerRow(row) {
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
