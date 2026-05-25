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
const VALID_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const DEFAULT_ANCHOR = 'top-left';

/**
 * Compute the 1-indexed sequential position for a slot in Cellarion's internal
 * coordinate system (top-left, row-major), given:
 *   - A sequential `position` from the source system, or
 *   - A (row, col) pair from the source system,
 * plus the rack's dimensions and where the source system's "bottle 1" sits.
 *
 * `anchor` describes the corner where the source data's position 1 (or row 1,
 * col 1) is located:
 *   - 'top-left'     : matches Cellarion's internal layout (identity)
 *   - 'top-right'    : column 1 is on the right
 *   - 'bottom-left'  : row 1 is at the bottom (Oeno reading left-to-right)
 *   - 'bottom-right' : row 1 at bottom AND col 1 on the right
 *
 * Returns { position } on success or { error } on bad input.
 */
function computeRackPosition({ position, row, col, rackRows, rackCols, anchor = DEFAULT_ANCHOR }) {
  if (!VALID_ANCHORS.includes(anchor)) {
    return { error: `Invalid anchor: ${anchor}` };
  }

  const cols = parseInt(rackCols, 10);
  const rows = parseInt(rackRows, 10);

  let srcRow, srcCol;

  if (position !== undefined && position !== null && position !== '') {
    const p = parseInt(position, 10);
    if (isNaN(p) || p < 1) return { error: 'Invalid position' };

    // Identity case — no dimensions needed when nothing to flip.
    if (anchor === 'top-left') return { position: p };

    if (isNaN(cols) || cols < 1) {
      return { error: 'rackCols is required to transform position with a non-default anchor' };
    }
    srcRow = Math.ceil(p / cols);
    srcCol = ((p - 1) % cols) + 1;
  } else {
    srcRow = parseInt(row, 10);
    srcCol = parseInt(col, 10);
    if (isNaN(srcRow) || srcRow < 1) return { error: 'Invalid row' };
    if (isNaN(srcCol) || srcCol < 1) return { error: 'Invalid col' };
    if (isNaN(cols) || cols < 1) return { error: 'rackCols is required to compute position from row/col' };
    if (srcCol > cols) return { error: `col ${srcCol} exceeds rackCols ${cols}` };
  }

  // Apply anchor transforms to land in Cellarion's top-left, row-major space.
  let effectiveRow = srcRow;
  let effectiveCol = srcCol;

  if (anchor === 'bottom-left' || anchor === 'bottom-right') {
    if (isNaN(rows) || rows < 1) {
      return { error: 'rackRows is required for bottom-anchored placement' };
    }
    if (srcRow > rows) return { error: `row ${srcRow} exceeds rackRows ${rows}` };
    effectiveRow = rows - srcRow + 1;
  }
  if (anchor === 'top-right' || anchor === 'bottom-right') {
    if (isNaN(cols) || cols < 1) {
      return { error: 'rackCols is required for right-anchored placement' };
    }
    effectiveCol = cols - srcCol + 1;
  }

  return { position: (effectiveRow - 1) * cols + effectiveCol };
}

/**
 * Suggest reasonable rack dimensions given a max position observed in import
 * data. Bias toward common physical wine-rack widths (6 or 12 columns) so
 * the auto-created rack matches what users typically own.
 */
function suggestRackDimensions(maxPosition) {
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
  // sequential `rackPosition` is known (no row/col coordinates), use
  // suggestRackDimensions() so the auto-created rack matches typical
  // physical layouts instead of becoming a 1-wide column.
  for (const entry of plan.values()) {
    if (!entry.rows && !entry.cols && entry.maxPosition > 0) {
      const suggestion = suggestRackDimensions(entry.maxPosition);
      entry.rows = suggestion.rows;
      entry.cols = suggestion.cols;
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
  suggestRackDimensions,
  DEFAULT_RACK_TYPE,
  DEFAULT_ANCHOR,
  VALID_ANCHORS,
};
