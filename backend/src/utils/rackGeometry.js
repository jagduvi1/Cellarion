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
      // `cols` bottles. See cabinetShelfRows / cabinetPosition for the
      // position contract.
      return cabinetShelfRows(rows, typeConfig).reduce((sum, r) => sum + cols * r, 0);
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
// imported bottle lands in its exact cell. Mirrored in
// frontend/src/utils/rackLayouts.cabinetLayout.

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
 * Global position of one cabinet cell, or null when the cell doesn't exist.
 * @param {{ shelfIndex: number, row: number, slot: number, cols: number, shelfRows: number[] }} c
 *   shelfIndex 0-based from the TOP; row and slot 1-based (see contract).
 */
function cabinetPosition({ shelfIndex, row, slot, cols, shelfRows }) {
  if (!Array.isArray(shelfRows) || shelfIndex < 0 || shelfIndex >= shelfRows.length) return null;
  if (!Number.isInteger(row) || row < 1 || row > shelfRows[shelfIndex]) return null;
  if (!Number.isInteger(slot) || slot < 1 || slot > cols) return null;
  let base = 0;
  for (let k = 0; k < shelfIndex; k++) base += cols * shelfRows[k];
  return base + (row - 1) * cols + slot;
}

/**
 * Request-time gate for a cabinet's typeConfig (create + update routes, MCP):
 * returns an error string or null. shelfRows must be an array of whole
 * numbers 1..12 whose length equals the shelf count; twoDeep and stagger
 * booleans. Non-cabinet racks may not carry any of them (a stale shelfRows on
 * a grid would be silently ignored by the geometry but is a client bug).
 */
function validateCabinetConfig(typeConfig, effectiveType, effectiveRows, effectiveModular) {
  if (!typeConfig || typeof typeConfig !== 'object') return null;
  const hasRows = typeConfig.shelfRows !== undefined && typeConfig.shelfRows !== null;
  const hasDeep = typeConfig.twoDeep !== undefined && typeConfig.twoDeep !== null;
  const hasStagger = typeConfig.stagger !== undefined && typeConfig.stagger !== null;
  if (!hasRows && !hasDeep && !hasStagger) return null;
  if (effectiveModular || effectiveType !== 'cabinet') {
    return 'shelfRows, twoDeep and stagger apply to cabinet racks only';
  }
  if (hasDeep && typeof typeConfig.twoDeep !== 'boolean') return 'twoDeep must be a boolean';
  if (hasStagger && typeof typeConfig.stagger !== 'boolean') return 'stagger must be a boolean';
  if (!hasRows) return 'shelfRows is required for a cabinet rack';
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
  return null;
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

module.exports = {
  totalSlots, modularTotalSlots, getMaxPosition, validDoubleHeightRows, validateDoubleHeightRows,
  cabinetShelfRows, cabinetPosition, validateCabinetConfig, CABINET_MAX_ROWS_PER_SHELF,
};
