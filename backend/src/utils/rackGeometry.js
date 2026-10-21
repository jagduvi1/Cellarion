/**
 * Rack geometry utilities — compute total slot counts per rack type.
 *
 * Each rack type interprets `rows` and `cols` differently:
 *   grid     — rows × cols rectangular grid; rows listed in
 *              typeConfig.doubleHeightRows have headroom for an extra top
 *              layer of cols-1 bottles resting in the gaps
 *   x-rack   — square with X dividers; 4 triangular sections, each holds bottlesPerSection bottles
 *   hex      — hex honeycomb; alternating row widths (cols, cols-1, …), or
 *              every row full width staggered when typeConfig.hexEqualRows
 *   triangle — A-frame; base width = cols, each row shrinks by 1
 *   stack    — single vertical column; height = rows
 *   cube     — grid of sub-modules; outer grid = rows × cols, each module = moduleRows × moduleCols
 *   shelf    — open case storage; rows × cols (same count as grid, different visual)
 */

/**
 * Filter typeConfig.doubleHeightRows down to the entries that actually
 * contribute top-layer capacity: unique integers in [1, rows], returned in
 * ascending order. A row only fits a top layer when cols > 1 (a single
 * bottle has no gap to rest another bottle in), so cols <= 1 yields [].
 * Defensive by design — routes reject invalid input with a 400, but racks
 * whose rows were shrunk after creation may still carry stale entries.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {Array<number>|undefined} doubleHeightRows 1-indexed row numbers
 * @returns {Array<number>} valid row numbers, ascending, deduplicated
 */
function validDoubleHeightRows(rows, cols, doubleHeightRows) {
  if (!Array.isArray(doubleHeightRows) || cols <= 1) return [];
  return [...new Set(doubleHeightRows)]
    .filter(r => Number.isInteger(r) && r >= 1 && r <= rows)
    .sort((a, b) => a - b);
}

/**
 * Validate REQUEST-supplied typeConfig.doubleHeightRows before it is stored:
 * grid racks (non-modular) only, entries must be integers in [1, rows]. The
 * runtime counterpart above (validDoubleHeightRows) is defensive filtering of
 * STORED data; this one rejects bad input with a message. Shared by the
 * create path (services/rackOps.createGridRack — REST POST /api/racks and MCP
 * both land there) and the REST rack-update route.
 *
 * See the POSITION NUMBERING CONTRACT in totalSlots below: the base grid
 * keeps positions 1..rows*cols row-major exactly as a plain grid, and
 * top-layer positions are appended after rows*cols — so this guard also
 * catches removing a double row while top-layer bottles are still placed
 * (via the routes' resize check on getMaxPosition).
 *
 * @returns {string|null} error message, or null when valid
 */
function validateDoubleHeightRows(typeConfig, effectiveType, effectiveRows, effectiveModular) {
  const dhr = typeConfig?.doubleHeightRows;
  if (dhr === undefined || dhr === null) return null;
  if (effectiveModular || (effectiveType || 'grid') !== 'grid') {
    return 'Double-height rows are only supported on grid racks';
  }
  if (!Array.isArray(dhr)) {
    return 'doubleHeightRows must be an array of row numbers';
  }
  for (const r of dhr) {
    if (!Number.isInteger(r) || r < 1 || r > effectiveRows) {
      return `doubleHeightRows entries must be whole row numbers between 1 and ${effectiveRows}`;
    }
  }
  return null;
}

/**
 * Total number of valid slot positions for a given rack configuration.
 */
function totalSlots(type, rows, cols, typeConfig) {
  // Geometry is arithmetic over the two dimensions; a non-finite dimension is
  // not a rack (the schema caps both at 20) and must never reach a formula
  // that could return Infinity/NaN into a slot bound. Fail to zero capacity.
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return 0;
  switch (type) {
    case 'grid': {
      // POSITION NUMBERING CONTRACT (double-height rows): the base grid
      // keeps positions 1..rows*cols row-major EXACTLY as a plain grid —
      // existing bottles never move. Top-layer positions are APPENDED after
      // rows*cols: iterate valid double-height rows in ascending row order,
      // each contributing cols-1 positions left-to-right (bottles resting
      // in the gaps between base bottles). Example 4x6 grid with
      // doubleHeightRows [2]: base 1..24 unchanged, top layer of row 2 =
      // positions 25..29.
      const doubles = validDoubleHeightRows(rows, cols, typeConfig?.doubleHeightRows);
      return rows * cols + doubles.length * (cols - 1);
    }

    case 'x-rack': {
      // Square with X dividers creating 4 triangular sections.
      // Each section holds bottlesPerSection bottles (default 10).
      const bps = typeConfig?.bottlesPerSection || 10;
      return 4 * bps;
    }

    case 'hex': {
      // Honeycomb grid: `rows` rows. Even rows (0-indexed) have `cols` slots,
      // odd rows have `cols - 1` slots (offset). With typeConfig.hexEqualRows
      // every row holds the full `cols` (offset rows still staggered by half
      // a slot — the equal-row shelf in wine fridges), so total = rows × cols.
      // hexFlip is deliberately not read here: it reverses which rows are
      // which, a pure reversal that can never change the total.
      if (typeConfig?.hexEqualRows) return rows * cols;
      // Closed form, not a loop (security audit 2026-09-02 D14-1): this ran
      // `rows` iterations, and the rack UPDATE route computed it on the
      // request's still-unvalidated rows before the schema's max-20 check —
      // one PUT with rows "1e308" parked the event loop for every tenant.
      // Even rows (0-indexed) hold `cols`, odd rows hold max(1, cols-1).
      const evenRows = Math.ceil(rows / 2);
      const oddRows = Math.floor(rows / 2);
      return evenRows * cols + oddRows * Math.max(1, cols - 1);
    }

    case 'triangle': {
      // A-frame: row 0 has `cols` slots, row 1 has `cols - 1`, etc.
      // Total = cols + (cols-1) + … + 1 = cols × (cols + 1) / 2
      // rows is derived from cols (= cols rows), so we use cols as the base.
      const base = cols;
      return (base * (base + 1)) / 2;
    }

    case 'stack':
      // Single column, height = rows
      return rows;

    case 'cube': {
      // Grid of sub-modules. Outer grid = rows × cols modules.
      // Each module = moduleRows × moduleCols slots.
      const mr = typeConfig?.moduleRows || 2;
      const mc = typeConfig?.moduleCols || 2;
      return rows * cols * mr * mc;
    }

    case 'shelf': {
      // Open case storage: rows × cols front compartments + optional backCols back row per shelf.
      const backCols = Math.max(0, typeConfig?.backCols || 0);
      const cells = rows * (cols + backCols);
      const bpc = typeConfig?.bottlesPerCell || 1;
      return cells * bpc;
    }

    case 'cabinet': {
      // Wine cabinet: `rows` shelves, shelf i holds shelfRows[i] rows of
      // `cols` bottles — or, when the cabinet alternates, of cols and cols−1
      // in turn (cabinetRowWidth). See cabinetPosition for the contract.
      const { twoDeep } = cabinetOptions(typeConfig);
      return cabinetBays(rows, cols, typeConfig)
        .reduce((sum, bay) => sum + cabinetBayCapacity(bay.rows, bay.cols, cabinetBayOpts(bay, twoDeep)), 0);
    }

    default: {
      // Fall back to grid behaviour (including double-height rows)
      const doubles = validDoubleHeightRows(rows, cols, typeConfig?.doubleHeightRows);
      return rows * cols + doubles.length * (cols - 1);
    }
  }
}

// ── Cabinet (wine fridge) geometry ───────────────────────────────────────
// POSITION NUMBERING CONTRACT (cabinet): shelves top to bottom (shelf index
// 0 = the top bay, so position 1 is top-left like every other type). Inside
// a bay, row r = 1..shelfRows[i] (row 1 rests on the plank), slot s = 1..cols
// left to right:
//     position = cols × Σ_{k<i} shelfRows[k] + (r − 1) × cols + s
// With typeConfig.twoDeep, row 1 is the bottom FRONT row, row 2 the bottom
// BACK row, row 3 the second level's front row, … — a visual arrangement the
// renderers share; the numbering above never changes with it. Oeno imports
// map shelf p (1 = bottom) → i = rows − p and layer L → r = L, so an
// imported bottle lands in its exact cell.
// With typeConfig.alternate the rows are NOT all `cols` wide: they alternate
// cols / cols−1 like a honeycomb (cabinetRowWidth), so the general form is
//     position = Σ (width of every row before this one, bay by bay) + s
// which reduces to the formula above when every row is `cols` wide. A cabinet
// created without the flag keeps its numbering exactly.
// PER-SHELF SHAPE: a shelf may be narrower than the cabinet (typeConfig
// .shelfCols[i], 1..cols) and may alternate or not on its own
// (typeConfig.shelfAlternate[i]); cabinetBays resolves every bay's rows,
// width and pattern, and the walk above simply uses the bay's own width. So a
// Liebherr GrandCru 5001 is one cabinet: three honeycomb shelves 6 wide
// between two staggered shelves 4 wide (support ticket 2026-08-31). Mirrored
// in frontend/src/utils/rackLayouts.cabinetLayout.

const CABINET_MAX_ROWS_PER_SHELF = 12;

/**
 * The per-shelf row list a cabinet rack actually uses: typeConfig.shelfRows
 * fitted to `rows` (missing entries count as 1, extras ignored, each entry
 * clamped to 1..12). Tolerant on READ so a rack whose config went missing
 * still renders; the WRITE gate is validateCabinetConfig.
 */
function cabinetShelfRows(rows, typeConfig) {
  const n = Number.isFinite(rows) && rows > 0 ? Math.min(20, Math.floor(rows)) : 0;
  const src = Array.isArray(typeConfig?.shelfRows) ? typeConfig.shelfRows : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = parseInt(src[i], 10);
    out.push(Number.isFinite(v) ? Math.max(1, Math.min(CABINET_MAX_ROWS_PER_SHELF, v)) : 1);
  }
  return out;
}

/**
 * The shape flags of a cabinet's typeConfig with their defaults: twoDeep is
 * on unless switched off, alternate is off unless switched on. (stagger is
 * drawing only and never reaches the geometry.)
 */
function cabinetOptions(typeConfig) {
  return { twoDeep: typeConfig?.twoDeep !== false, alternate: typeConfig?.alternate === true };
}

/**
 * Per-shelf width list fitted to `rows`: typeConfig.shelfCols, a missing or
 * unusable entry meaning the cabinet's own width, each clamped to 1..cols.
 * Tolerant on READ like cabinetShelfRows.
 */
function cabinetShelfCols(rows, cols, typeConfig) {
  const n = Number.isFinite(rows) && rows > 0 ? Math.min(20, Math.floor(rows)) : 0;
  const full = Number.isFinite(cols) && cols > 0 ? Math.min(20, Math.floor(cols)) : 1;
  const src = Array.isArray(typeConfig?.shelfCols) ? typeConfig.shelfCols : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = parseInt(src[i], 10);
    out.push(Number.isFinite(v) ? Math.max(1, Math.min(full, v)) : full);
  }
  return out;
}

/**
 * Per-shelf alternate list fitted to `rows`: typeConfig.shelfAlternate, a
 * missing entry meaning the cabinet's own `alternate` flag.
 */
function cabinetShelfAlternate(rows, typeConfig) {
  const n = Number.isFinite(rows) && rows > 0 ? Math.min(20, Math.floor(rows)) : 0;
  const fallback = typeConfig?.alternate === true;
  const src = Array.isArray(typeConfig?.shelfAlternate) ? typeConfig.shelfAlternate : [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(typeof src[i] === 'boolean' ? src[i] : fallback);
  return out;
}

// How a shelf's bottles lie: '' front to back, 'front' the first bottle of
// the bottom row across the front, 'all' every bottle across (a bottom bin).
const CABINET_SIDEWAYS = ['', 'front', 'all'];

/**
 * Per-shelf lie list fitted to `rows` (typeConfig.shelfSideways; a missing or
 * unknown entry means front to back). Mostly drawing: the one place it counts
 * is a stacked shelf of a one-deep cabinet with a bottle across the front,
 * whose levels above the first hold one bottle fewer (cabinetRowWidth).
 * Tolerant on READ like cabinetShelfRows.
 */
function cabinetShelfSideways(rows, typeConfig) {
  const n = Number.isFinite(rows) && rows > 0 ? Math.min(20, Math.floor(rows)) : 0;
  const src = Array.isArray(typeConfig?.shelfSideways) ? typeConfig.shelfSideways : [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(CABINET_SIDEWAYS.includes(src[i]) ? src[i] : '');
  return out;
}

/**
 * Every bay of a cabinet, top first, with its resolved shape:
 * { rows, cols, alternate, sideways } — the row count, the bay's own width
 * (≤ the cabinet's), whether its rows alternate, and how its bottles lie
 * (see cabinetShelfSideways). The one place the per-shelf lists are combined;
 * everything else reads bays.
 */
function cabinetBays(rows, cols, typeConfig) {
  const rowList = cabinetShelfRows(rows, typeConfig);
  const colList = cabinetShelfCols(rows, cols, typeConfig);
  const altList = cabinetShelfAlternate(rows, typeConfig);
  const sideList = cabinetShelfSideways(rows, typeConfig);
  return rowList.map((r, i) => ({ rows: r, cols: colList[i], alternate: altList[i], sideways: sideList[i] }));
}

/**
 * Bottles in row `row` (1-based, from the plank) of a cabinet bay. Every row
 * holds `cols` unless the cabinet ALTERNATES (typeConfig.alternate): then the
 * bay is a honeycomb — the first level's front row holds cols, its back row
 * lies in the gaps between those bottles and holds one fewer, the level
 * above nests in the grooves of the first so its front row holds one fewer
 * and its back row is full width again, and so on: 6 / 5 in front of 5 / 6,
 * the wooden shelf of a Liebherr GrandCru (support ticket 2026-09-15).
 * Without twoDeep the levels simply alternate cols, cols−1, cols, …
 * A single-bottle-wide cabinet has nothing to alternate (never 0 wide).
 *
 * One bottle across the front (sideways 'front') of a ONE-deep shelf: the
 * first row is that bottle plus cols−1 lying front to back behind it, and the
 * levels above rest on those, so they are counted from cols−1. A slim
 * fridge's stacked shelf: 1 across + 4, with 3 in the grooves on top (forum
 * 2026-10-14; it used to stack 4 on 3). Two deep is left as it was: there the
 * front and back rows share the level, and the bottle across lies in front
 * of both.
 */
function cabinetRowWidth(row, cols, { twoDeep = true, alternate = false, sideways = '' } = {}) {
  const base = sideways === 'front' && !twoDeep && row > 1 ? Math.max(1, cols - 1) : cols;
  if (!alternate) return base;
  const level = twoDeep ? Math.ceil(row / 2) : row;
  const isBack = twoDeep && row % 2 === 0;
  const wide = (level % 2 === 1) !== isBack;
  return wide ? base : Math.max(1, base - 1);
}

/** Bottles a bay of `rowCount` rows holds: the sum of its rows (cabinetRowWidth). */
function cabinetBayCapacity(rowCount, cols, opts) {
  let n = 0;
  for (let r = 1; r <= rowCount; r++) n += cabinetRowWidth(r, cols, opts);
  return n;
}

/** The options cabinetRowWidth needs for one bay of a cabinet. */
function cabinetBayOpts(bay, twoDeep) {
  return { twoDeep, alternate: bay.alternate, sideways: bay.sideways };
}

/**
 * Every bottle row of a cabinet in position order — bay by bay from the top,
 * rows from the plank up — as { shelfIndex, row, start, width }: `start` is
 * the position just before the row's first slot, `width` its bottle count.
 * The one walk importers and the row/col mapping share.
 */
function cabinetRows(rows, cols, typeConfig) {
  const { twoDeep } = cabinetOptions(typeConfig);
  const out = [];
  let start = 0;
  cabinetBays(rows, cols, typeConfig).forEach((bay, shelfIndex) => {
    const opts = cabinetBayOpts(bay, twoDeep);
    for (let row = 1; row <= bay.rows; row++) {
      const width = cabinetRowWidth(row, bay.cols, opts);
      out.push({ shelfIndex, row, start, width });
      start += width;
    }
  });
  return out;
}

/**
 * Global position of one cabinet cell, or null when the cell doesn't exist.
 * @param {{ shelfIndex: number, row: number, slot: number, cols: number, shelfRows: number[],
 *   twoDeep?: boolean, alternate?: boolean, shelfCols?: number[], shelfAlternate?: boolean[] }} c
 *   shelfIndex 0-based from the TOP; row and slot 1-based (see contract).
 *   The rest is the cabinet's typeConfig (defaults as stored: twoDeep on,
 *   alternate off, every shelf the cabinet's width).
 */
function cabinetPosition({ shelfIndex, row, slot, cols, shelfRows, twoDeep, alternate, shelfCols, shelfAlternate, shelfSideways }) {
  if (!Array.isArray(shelfRows) || shelfIndex < 0 || shelfIndex >= shelfRows.length) return null;
  const typeConfig = { shelfRows, twoDeep, alternate, shelfCols, shelfAlternate, shelfSideways };
  const bays = cabinetBays(shelfRows.length, cols, typeConfig);
  const bay = bays[shelfIndex];
  if (!Number.isInteger(row) || row < 1 || row > bay.rows) return null;
  const deep = cabinetOptions(typeConfig).twoDeep;
  if (!Number.isInteger(slot) || slot < 1 || slot > cabinetRowWidth(row, bay.cols, cabinetBayOpts(bay, deep))) return null;
  let base = 0;
  for (let k = 0; k < shelfIndex; k++) base += cabinetBayCapacity(bays[k].rows, bays[k].cols, cabinetBayOpts(bays[k], deep));
  for (let r = 1; r < row; r++) base += cabinetRowWidth(r, bay.cols, cabinetBayOpts(bay, deep));
  return base + slot;
}

/**
 * Request-time gate for a cabinet's typeConfig (create + update routes, MCP):
 * returns an error string or null. shelfRows must be an array of whole
 * numbers 1..12 whose length equals the shelf count; twoDeep, stagger,
 * headToTail and alternate booleans (headToTail only with twoDeep off: a
 * row lies head to tail one deep, never neck to neck); the optional
 * per-shelf lists shelfCols (whole numbers 1..cols, one per shelf),
 * shelfAlternate (booleans, one per shelf) and shelfSideways ('', 'front' or
 * 'all', one per shelf — mostly drawing; where it changes a width, on a
 * stacked one-deep shelf, the update route refuses it on a loaded cabinet).
 * Non-cabinet racks may not carry any of them (a stale shelfRows on a grid
 * would be silently ignored by the geometry but is a client bug).
 * `effectiveCols` bounds shelfCols; when the caller has none, that bound
 * falls back to the schema's 20.
 */
function validateCabinetConfig(typeConfig, effectiveType, effectiveRows, effectiveModular, effectiveCols) {
  if (!typeConfig || typeof typeConfig !== 'object') return null;
  const present = (k) => typeConfig[k] !== undefined && typeConfig[k] !== null;
  const keys = ['shelfRows', 'twoDeep', 'stagger', 'headToTail', 'alternate', 'shelfCols', 'shelfAlternate', 'shelfSideways'];
  if (!keys.some(present)) return null;
  if (effectiveModular || effectiveType !== 'cabinet') {
    return 'shelfRows, twoDeep, stagger, headToTail, alternate, shelfCols, shelfAlternate and shelfSideways apply to cabinet racks only';
  }
  if (present('twoDeep') && typeof typeConfig.twoDeep !== 'boolean') return 'twoDeep must be a boolean';
  if (present('stagger') && typeof typeConfig.stagger !== 'boolean') return 'stagger must be a boolean';
  if (present('alternate') && typeof typeConfig.alternate !== 'boolean') return 'alternate must be a boolean';
  if (present('headToTail') && typeof typeConfig.headToTail !== 'boolean') return 'headToTail must be a boolean';
  if (typeConfig.headToTail === true && typeConfig.twoDeep !== false) {
    return 'headToTail needs twoDeep off: bottles head to tail lie one deep, not neck to neck';
  }
  if (!present('shelfRows')) return 'shelfRows is required for a cabinet rack';
  const list = typeConfig.shelfRows;
  const rows = parseInt(effectiveRows, 10);
  if (!Array.isArray(list) || !Number.isFinite(rows) || list.length !== rows) {
    return 'shelfRows must list one entry per shelf (its length must equal rows)';
  }
  for (const v of list) {
    if (!Number.isInteger(v) || v < 1 || v > CABINET_MAX_ROWS_PER_SHELF) {
      return `Each shelfRows entry must be a whole number between 1 and ${CABINET_MAX_ROWS_PER_SHELF}`;
    }
  }
  if (present('shelfCols')) {
    const cols = parseInt(effectiveCols, 10);
    const max = Number.isFinite(cols) && cols >= 1 ? cols : 20;
    const widths = typeConfig.shelfCols;
    if (!Array.isArray(widths) || widths.length !== rows) {
      return 'shelfCols must list one entry per shelf (its length must equal rows)';
    }
    for (const v of widths) {
      if (!Number.isInteger(v) || v < 1 || v > max) {
        return `Each shelfCols entry must be a whole number between 1 and the cabinet width (${max})`;
      }
    }
  }
  if (present('shelfAlternate')) {
    const flags = typeConfig.shelfAlternate;
    if (!Array.isArray(flags) || flags.length !== rows) {
      return 'shelfAlternate must list one entry per shelf (its length must equal rows)';
    }
    if (flags.some((v) => typeof v !== 'boolean')) return 'Each shelfAlternate entry must be a boolean';
  }
  if (present('shelfSideways')) {
    const lies = typeConfig.shelfSideways;
    if (!Array.isArray(lies) || lies.length !== rows) {
      return 'shelfSideways must list one entry per shelf (its length must equal rows)';
    }
    if (lies.some((v) => !CABINET_SIDEWAYS.includes(v))) {
      return 'Each shelfSideways entry must be "" (front to back), "front" (one bottle across the front) or "all" (every bottle across)';
    }
  }
  return null;
}

/**
 * The cabinet typeConfig an import stores: every list fitted to the shelf
 * count, every flag a real boolean (headToTail only one deep), and a per-shelf
 * key that is not a list DROPPED — a hand-edited file's `"shelfSideways":
 * "front"` used to be stored as a one-entry list on a 3-shelf cabinet, and
 * every later edit of the rack was then refused (release audit 2026-10-13).
 * Other keys pass through untouched.
 */
function fitCabinetTypeConfig(rows, cols, typeConfig) {
  const tc = typeConfig && typeof typeConfig === 'object' ? typeConfig : {};
  // A grid-only key in a hand-edited export would make every later edit of
  // the cabinet a 400 ("only supported on grid racks" — audit 2026-10-14).
  delete tc.doubleHeightRows;
  return {
    ...tc,
    shelfRows: cabinetShelfRows(rows, tc),
    twoDeep: tc.twoDeep !== false,
    stagger: tc.stagger !== false,
    headToTail: tc.twoDeep === false && tc.headToTail === true,
    alternate: tc.alternate === true,
    shelfCols: Array.isArray(tc.shelfCols) ? cabinetShelfCols(rows, cols, tc) : undefined,
    shelfAlternate: Array.isArray(tc.shelfAlternate) ? cabinetShelfAlternate(rows, tc) : undefined,
    shelfSideways: Array.isArray(tc.shelfSideways) ? cabinetShelfSideways(rows, tc) : undefined,
  };
}

/**
 * Total slots for a modular rack (sum of all modules).
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object }>} modules
 * @returns {number}
 */
function modularTotalSlots(modules) {
  if (!modules || modules.length === 0) return 0;
  return modules.reduce((sum, m) => sum + totalSlots(m.type, m.rows, m.cols, m.typeConfig), 0);
}

/**
 * Convenience: get max position for a rack document.
 * Handles both simple and modular racks.
 * @param {{ isModular?: boolean, modules?: Array, type?: string, rows: number, cols: number, typeConfig?: object }} rack
 * @returns {number}
 */
function getMaxPosition(rack) {
  if (rack.isModular && rack.modules?.length > 0) {
    return modularTotalSlots(rack.modules);
  }
  return totalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
}

/**
 * Where a slot position is, in the words someone at the rack uses — the
 * reverse of the POSITION NUMBERING CONTRACTS above:
 *   cabinet — shelf (1 = the top bay), row within that shelf (1 = resting on
 *             the plank, counting up; two deep: 1 front, 2 back, 3 the next
 *             level's front, …) and col (the slot in that row, left to right).
 *             The walk is cabinetRows, so alternating, narrower and stacked
 *             one-deep-with-a-bottle-across shelves land in their real cell.
 *   grid    — row and col of the row-major base grid (the cellar export's
 *             rackRow / rackCol). A top-layer position of a double-height row
 *             (appended after rows × cols) reports that row and its place in
 *             the top layer, left to right (1..cols−1).
 * Every other type, a modular rack, and a position the rack does not have
 * answer all nulls — the position itself is still the caller's to report.
 * Shared by GET /api/inventory and the MCP get_bottle placement.
 *
 * @param {{ type?: string, rows: number, cols: number, typeConfig?: object,
 *   isModular?: boolean, modules?: Array }} rack
 * @param {number} position 1-based slot position
 * @returns {{ shelf: number|null, row: number|null, col: number|null }}
 */
function slotLocation(rack, position) {
  const none = { shelf: null, row: null, col: null };
  if (!rack || !Number.isInteger(position) || position < 1) return none;
  if (rack.isModular && Array.isArray(rack.modules) && rack.modules.length > 0) return none;
  const { rows, cols } = rack;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return none;
  const type = rack.type || 'grid';

  if (type === 'cabinet') {
    for (const r of cabinetRows(rows, cols, rack.typeConfig)) {
      if (position > r.start && position <= r.start + r.width) {
        return { shelf: r.shelfIndex + 1, row: r.row, col: position - r.start };
      }
    }
    return none;
  }

  if (type === 'grid') {
    const base = rows * cols;
    if (position <= base) {
      return { shelf: null, row: Math.ceil(position / cols), col: ((position - 1) % cols) + 1 };
    }
    let start = base;
    for (const row of validDoubleHeightRows(rows, cols, rack.typeConfig?.doubleHeightRows)) {
      if (position <= start + cols - 1) return { shelf: null, row, col: position - start };
      start += cols - 1;
    }
    return none;
  }

  return none;
}

module.exports = {
  slotLocation,
  totalSlots, modularTotalSlots, getMaxPosition, validDoubleHeightRows, validateDoubleHeightRows,
  cabinetShelfRows, cabinetPosition, validateCabinetConfig, CABINET_MAX_ROWS_PER_SHELF,
  cabinetOptions, cabinetRowWidth, cabinetBayCapacity, cabinetBayOpts, cabinetRows,
  cabinetShelfCols, cabinetShelfAlternate, cabinetShelfSideways, cabinetBays, CABINET_SIDEWAYS,
  fitCabinetTypeConfig,
};
