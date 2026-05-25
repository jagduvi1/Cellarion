/**
 * Rack-aware import helpers.
 *
 * Translates the (rackName, row, col) / rackPosition shape used in CSV exports
 * from other cellar apps (Oeno/Vintec, CellarTracker, Vivino, …) into the
 * single 1-indexed `position` Cellarion stores on a rack's slots.
 *
 * Also derives a "plan" for auto-creating racks that don't yet exist in the
 * target cellar, inferring dimensions from the rack's own rows when not given
 * explicitly in the CSV.
 */

const { totalSlots } = require('./rackGeometry');

const DEFAULT_RACK_TYPE = 'grid';
const VALID_ROW_ORIGINS = ['top', 'bottom'];

/**
 * Compute the 1-indexed sequential position for a rack slot, given either
 * an explicit position or a (row, col) pair plus the rack's row/col count.
 *
 * Supports `rowOrigin = 'bottom'` for apps (like Oeno) where row 1 is the
 * physical bottom of the rack. The default is 'top' which matches how
 * Cellarion's grid renders.
 *
 * Returns:
 *   { position: number }            on success
 *   { error: string }               when the inputs can't produce a position
 *
 * Only meaningful for grid-shaped racks (grid, shelf). For other types we
 * still fall back to a row-major formula but consumers should generally
 * pass an explicit `position` when working with hex/triangle/x-rack/cube.
 */
function computeRackPosition({ position, row, col, rackRows, rackCols, rowOrigin = 'top' }) {
  if (!VALID_ROW_ORIGINS.includes(rowOrigin)) {
    return { error: `Invalid rowOrigin: ${rowOrigin}` };
  }

  // Explicit position wins — used as-is.
  if (position !== undefined && position !== null && position !== '') {
    const p = parseInt(position, 10);
    if (isNaN(p) || p < 1) return { error: 'Invalid position' };
    return { position: p };
  }

  // Otherwise we need row + col + rackCols at minimum.
  const r = parseInt(row, 10);
  const c = parseInt(col, 10);
  const rows = parseInt(rackRows, 10);
  const cols = parseInt(rackCols, 10);

  if (isNaN(r) || r < 1) return { error: 'Invalid row' };
  if (isNaN(c) || c < 1) return { error: 'Invalid col' };
  if (isNaN(cols) || cols < 1) return { error: 'rackCols is required to compute position from row/col' };
  if (c > cols) return { error: `col ${c} exceeds rackCols ${cols}` };

  let effectiveRow = r;
  if (rowOrigin === 'bottom') {
    if (isNaN(rows) || rows < 1) {
      return { error: 'rackRows is required when rowOrigin is "bottom"' };
    }
    if (r > rows) return { error: `row ${r} exceeds rackRows ${rows}` };
    effectiveRow = rows - r + 1;
  }

  return { position: (effectiveRow - 1) * cols + c };
}

/**
 * Build a plan of racks to auto-create from a batch of import items.
 *
 * For each unique rackName seen in items, infer:
 *   - type        — from item.rackType, else 'grid'
 *   - rows, cols  — from explicit rackRows/rackCols on any item, else inferred
 *                   from the max row/col observed; falls back to capacity that
 *                   covers the highest position seen
 *
 * Returns a Map keyed by rackName so the caller can `findOne` and skip the
 * plan entry if the rack already exists in the cellar.
 */
function planRackCreations(items) {
  const plan = new Map(); // rackName -> { type, rows, cols, maxPosition }

  for (const item of items) {
    if (!item || !item.rackName) continue;
    const name = String(item.rackName).trim();
    if (!name) continue;

    let entry = plan.get(name);
    if (!entry) {
      entry = { type: DEFAULT_RACK_TYPE, rows: 0, cols: 0, maxPosition: 0 };
      plan.set(name, entry);
    }

    if (item.rackType) entry.type = String(item.rackType).trim().toLowerCase();

    const declaredRows = parseInt(item.rackRows, 10);
    const declaredCols = parseInt(item.rackCols, 10);
    if (!isNaN(declaredRows) && declaredRows > entry.rows) entry.rows = declaredRows;
    if (!isNaN(declaredCols) && declaredCols > entry.cols) entry.cols = declaredCols;

    const row = parseInt(item.row, 10);
    const col = parseInt(item.col, 10);
    if (!isNaN(row) && row > entry.rows) entry.rows = row;
    if (!isNaN(col) && col > entry.cols) entry.cols = col;

    const pos = parseInt(item.rackPosition, 10);
    if (!isNaN(pos) && pos > entry.maxPosition) entry.maxPosition = pos;
  }

  // Finalise each entry: ensure rows/cols are at least 1, and that the rack's
  // capacity covers the highest position we'll try to place into. When only a
  // sequential `rackPosition` is known (no row/col coordinates), fall back to
  // a typical wine-rack width of 6 columns so the auto-created rack matches
  // common physical layouts instead of becoming a 1-wide column.
  for (const entry of plan.values()) {
    if (!entry.rows && !entry.cols && entry.maxPosition > 0) {
      entry.cols = 6;
      entry.rows = Math.max(4, Math.ceil(entry.maxPosition / entry.cols));
    }
    if (!entry.rows) entry.rows = 1;
    if (!entry.cols) entry.cols = 1;

    // Grow capacity to fit the highest position if needed (grid + shelf).
    if (entry.type === 'grid' || entry.type === 'shelf') {
      const capacity = totalSlots(entry.type, entry.rows, entry.cols);
      if (entry.maxPosition > capacity) {
        entry.rows = Math.ceil(entry.maxPosition / entry.cols);
      }
    }

    // Clamp to the Mongoose schema's max of 20 — anything bigger and the rack
    // will need to be created manually as a modular rack instead.
    if (entry.rows > 20) entry.rows = 20;
    if (entry.cols > 20) entry.cols = 20;

    delete entry.maxPosition;
  }

  return plan;
}

module.exports = {
  computeRackPosition,
  planRackCreations,
  DEFAULT_RACK_TYPE,
  VALID_ROW_ORIGINS,
};
