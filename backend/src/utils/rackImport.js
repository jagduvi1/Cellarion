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
  const plan = new Map(); // rackName -> { type, rows, cols, maxPosition, totalBottles }

  for (const item of items) {
    if (!item || !item.rackName) continue;
    const name = String(item.rackName).trim();
    if (!name) continue;

    let entry = plan.get(name);
    if (!entry) {
      entry = { type: DEFAULT_RACK_TYPE, rows: 0, cols: 0, maxPosition: 0, totalBottles: 0 };
      plan.set(name, entry);
    }

    // Every item in the (already quantity-expanded) batch counts as one bottle
    // that will claim a slot in this rack — needed so we size the rack big
    // enough to hold them all, not just to cover the highest slot number used.
    entry.totalBottles += 1;

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

  // Finalise each entry: pick row/col so the rack has capacity for *both* the
  // highest slot number referenced AND the total number of bottles claiming
  // it (the latter matters when multiple bottles want the same slot — e.g.
  // Oeno's "Quantity: 3, Rack_Location: M3-11" expands to 3 bottles all
  // pointing at slot 11; they need to spill into 2 more slots).
  for (const entry of plan.values()) {
    const requiredCapacity = Math.max(entry.maxPosition || 0, entry.totalBottles || 0);

    if (!entry.rows && !entry.cols && requiredCapacity > 0) {
      const suggestion = suggestRackDimensions(requiredCapacity);
      entry.rows = suggestion.rows;
      entry.cols = suggestion.cols;
    }
    if (!entry.rows) entry.rows = 1;
    if (!entry.cols) entry.cols = 1;

    // Grow capacity to fit if needed (grid + shelf).
    if (entry.type === 'grid' || entry.type === 'shelf') {
      const capacity = totalSlots(entry.type, entry.rows, entry.cols);
      if (requiredCapacity > capacity) {
        entry.rows = Math.ceil(requiredCapacity / entry.cols);
      }
    }

    // Clamp to the Mongoose schema's max of 20 — anything bigger and the rack
    // will need to be created manually as a modular rack instead.
    if (entry.rows > 20) entry.rows = 20;
    if (entry.cols > 20) entry.cols = 20;

    delete entry.maxPosition;
    delete entry.totalBottles;
  }

  return plan;
}

/**
 * End-to-end placement orchestration for a single rack: translate each item's
 * (source-system) position via the anchor, then run the two-pass algorithm.
 *
 * Pure function — does not touch Mongo. The caller passes in the rack's
 * geometry + existing slots and gets back a list of slot writes + the
 * collection of items that couldn't be placed and why.
 *
 * @param {{type, rows, cols, typeConfig, slots, maxPosition}} rack
 * @param {Array<{item: object, bottleId: any, sourceIndex?: number}>} items
 * @param {string} anchor One of VALID_ANCHORS
 * @returns {{
 *   placements: Array<{position: number, bottle: any, overflowed?: boolean}>,
 *   unplaced: Array<{sourceIndex?: number, requestedPosition: number|null, reason: string}>
 * }}
 */
function placeBottlesInRack(rack, items, anchor) {
  const requests = [];
  const unplaced = [];

  for (const it of items) {
    const result = computeRackPosition({
      position: it.item.rackPosition,
      row: it.item.row,
      col: it.item.col,
      rackRows: rack.rows,
      rackCols: rack.cols,
      anchor
    });
    if (result.error) {
      unplaced.push({ sourceIndex: it.sourceIndex, requestedPosition: null, reason: result.error });
      continue;
    }
    if (result.position > rack.maxPosition) {
      unplaced.push({
        sourceIndex: it.sourceIndex,
        requestedPosition: result.position,
        reason: `Slot ${result.position} exceeds rack capacity (${rack.maxPosition})`
      });
      continue;
    }
    requests.push({ requestedPosition: result.position, bottleId: it.bottleId, sourceIndex: it.sourceIndex });
  }

  const { placements, unplaced: tooFull } = placeBottles(rack.slots || [], requests, rack.maxPosition);

  for (const t of tooFull) {
    unplaced.push({ sourceIndex: t.sourceIndex, requestedPosition: t.requestedPosition, reason: 'Rack full' });
  }

  return { placements, unplaced };
}

/**
 * Find the closest free position to `requestedPosition` within [1, maxPosition].
 * Scans forward first, then backward. Returns null if the rack is full.
 */
function findNextFreeSlot(occupied, requestedPosition, maxPosition) {
  for (let p = requestedPosition + 1; p <= maxPosition; p++) {
    if (!occupied.has(p)) return p;
  }
  for (let p = requestedPosition - 1; p >= 1; p--) {
    if (!occupied.has(p)) return p;
  }
  return null;
}

/**
 * Two-pass placement: bottles get their exact requested slot when free
 * (pass 1, first-come-first-served), then unplaced bottles overflow into
 * the nearest empty slot (pass 2). Returns the list of placements to add
 * to the rack plus any bottles that couldn't fit.
 *
 * @param {Array<{position: number, bottle: any}>} existingSlots
 *        Slots already on the rack (their positions are off-limits).
 * @param {Array<{requestedPosition: number, bottleId: any, sourceIndex?: number}>} requests
 *        Bottles wanting a slot in this rack, in the order they came from the CSV.
 * @param {number} maxPosition Total addressable slots in this rack.
 * @returns {{placements: Array, unplaced: Array}}
 */
function placeBottles(existingSlots, requests, maxPosition) {
  const occupied = new Set((existingSlots || []).map(s => s.position));
  const placements = [];
  const overflow = [];

  // Pass 1: exact placement, first request to a slot wins.
  for (const req of requests) {
    const pos = parseInt(req.requestedPosition, 10);
    if (!isNaN(pos) && pos >= 1 && pos <= maxPosition && !occupied.has(pos)) {
      placements.push({ position: pos, bottle: req.bottleId, request: req });
      occupied.add(pos);
    } else {
      overflow.push(req);
    }
  }

  // Pass 2: overflow into nearest empty slot.
  const unplaced = [];
  for (const req of overflow) {
    const target = findNextFreeSlot(occupied, parseInt(req.requestedPosition, 10) || 1, maxPosition);
    if (target !== null) {
      placements.push({ position: target, bottle: req.bottleId, request: req, overflowed: true });
      occupied.add(target);
    } else {
      unplaced.push(req);
    }
  }

  return { placements, unplaced };
}

module.exports = {
  computeRackPosition,
  planRackCreations,
  suggestRackDimensions,
  findNextFreeSlot,
  placeBottles,
  placeBottlesInRack,
  DEFAULT_RACK_TYPE,
  DEFAULT_ANCHOR,
  VALID_ANCHORS,
};
