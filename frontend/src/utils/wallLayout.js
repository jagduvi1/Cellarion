/**
 * Drawing a 'wall' rack: one rack built from boxes on a grid of equal cells.
 * The stored shape, the position numbering contract and the rules of an edit
 * are in backend/src/utils/wallGeometry.js; the counting half of this file
 * (BOX_KINDS, PILE_SECTIONS, boxCapacity, wallBoxes, wallTotalSlots,
 * boxLabel) mirrors it, and wallLayout.test.js holds the two together.
 *
 * What only the drawing decides is WHERE a slot is:
 *   - A pile (an X's triangle, half of a diagonal box, an open bin) fills
 *     from its lowest point, row nesting on row, the way bottles lie in a
 *     real bin. Slot i of a pile is the i-th bottle from the bottom.
 *   - The wall is true to scale: every cell is as large as the fullest box
 *     needs, so a box that holds less is drawn with room to spare.
 */

export const BOX_KINDS = ['x', 'slash', 'backslash', 'bin', 'rack', 'shelves', 'closed'];
// How many separate piles the planks of a box make.
export const PILE_SECTIONS = { x: 4, slash: 2, backslash: 2, bin: 1 };
const MAX_PER_SECTION = 60;
const MAX_BOX_DIM = 20;

// The slot circle and the rack pitch of utils/rackLayouts.js (kept equal by a
// test; importing them would make the two files import each other).
const SLOT_R = 20;
const CELL = 48;
const PITCH = 44;                        // centre to centre in a pile
const ROW_H = PITCH * Math.sqrt(3) / 2;  // a pile's rows nest
const INSET = 6;                         // half a plank
const CLEAR = SLOT_R + 4;                // a slot's centre keeps this far from every plank
const MARGIN = 14;
// Room above and left of the wall for the column letters and row numbers.
const GUTTER = 34;
const MIN_CELL = 170;
const CELL_STEP = 6;
// Far beyond what the largest box asks for; it only bounds the search.
const MAX_CELL = 3000;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isPile = (kind) => Object.prototype.hasOwnProperty.call(PILE_SECTIONS, kind);
const isGrid = (kind) => kind === 'rack' || kind === 'shelves';

/** How many bottles a box holds; 0 for a closed box or one that states no valid size. */
export function boxCapacity(box) {
  if (!box) return 0;
  if (isPile(box.kind)) {
    return isInt(box.perSection, 1, MAX_PER_SECTION) ? PILE_SECTIONS[box.kind] * box.perSection : 0;
  }
  if (isGrid(box.kind)) {
    return isInt(box.rows, 1, MAX_BOX_DIM) && isInt(box.cols, 1, MAX_BOX_DIM) ? box.rows * box.cols : 0;
  }
  return 0;
}

const inWall = (b, rows, cols) => isInt(b.x, 0, cols - 1) && isInt(b.y, 0, rows - 1)
  && isInt(b.w, 1, cols - b.x) && isInt(b.h, 1, rows - b.y);

/** The boxes of a wall in position order: top to bottom, then left to right. */
export function wallBoxes(rows, cols, typeConfig) {
  const list = typeConfig?.boxes;
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && BOX_KINDS.includes(b.kind) && inWall(b, rows, cols))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Total slots of a wall, without any coordinates. */
export function wallTotalSlots(rows, cols, typeConfig) {
  return wallBoxes(rows, cols, typeConfig).reduce((sum, b) => sum + boxCapacity(b), 0);
}

// A column's letter: A … Z, then AA.
function columnLetters(column) {
  let n = column;
  let letters = '';
  do { letters = String.fromCharCode(65 + (n % 26)) + letters; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return letters;
}

/** A box's name on the wall: its column as a letter and its row as a number, "B2". */
export function boxLabel(box) {
  return `${columnLetters(box.x)}${box.y + 1}`;
}

// The piles of a box in the contract's order, as someone at the wall would
// point at them. An open bin is one pile and needs no word.
export const SECTION_NAMES = {
  x: ['top', 'left', 'right', 'bottom'],
  slash: ['upper', 'lower'],
  backslash: ['upper', 'lower'],
  bin: [null],
};

/**
 * Where a position of a wall is: the box ("B2"), and in it either the pile
 * and the bottle's count from the bottom of that pile, or the row and the
 * bottle's place in the row. { box, kind, section, slot, row, col }, or null
 * for a position the wall does not have. Mirrors backend wallGeometry
 * wallPlace, which the server sends as `wall` with a bottle's slot; this one
 * serves the screens that hold the rack itself (utils/slotLabel.js has the
 * words).
 */
export function wallPlace(rows, cols, typeConfig, position) {
  if (!Number.isInteger(position) || position < 1) return null;
  let start = 0;
  for (const box of wallBoxes(rows, cols, typeConfig)) {
    const capacity = boxCapacity(box);
    if (position <= start + capacity) {
      const index = position - start - 1;
      if (isPile(box.kind)) {
        return {
          box: boxLabel(box), kind: box.kind,
          section: SECTION_NAMES[box.kind][Math.floor(index / box.perSection)], slot: (index % box.perSection) + 1,
          row: null, col: null,
        };
      }
      return {
        box: boxLabel(box), kind: box.kind, section: null, slot: null,
        row: Math.floor(index / box.cols) + 1, col: (index % box.cols) + 1,
      };
    }
    start += capacity;
  }
  return null;
}

/** That place for a rack as a page holds it: null unless the rack is a wall. */
export function slotPlace(rack, position) {
  if (!rack || rack.isModular || rack.type !== 'wall') return null;
  return wallPlace(rack.rows, rack.cols, rack.typeConfig, position);
}

// ── Piles ───────────────────────────────────────────────────────────────────

// The areas the planks of a pile box divide it into, in the contract's order.
function sectionsOf(kind, x0, y0, x1, y1) {
  const TL = { x: x0, y: y0 }, TR = { x: x1, y: y0 }, BR = { x: x1, y: y1 }, BL = { x: x0, y: y1 };
  const C = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  if (kind === 'x') return [[TL, TR, C], [TL, C, BL], [TR, BR, C], [BL, C, BR]];
  if (kind === 'slash') return [[TL, TR, BL], [BL, TR, BR]];
  if (kind === 'backslash') return [[TL, TR, BR], [TL, BR, BL]];
  return [[TL, TR, BR, BL]];
}

// Each edge as an inward unit normal n and offset d: a point p is inside by
// `m` when n·p − d ≥ m.
function edgesOf(poly) {
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny);
    nx /= len; ny /= len;
    let d = nx * a.x + ny * a.y;
    if (nx * cx + ny * cy - d < 0) { nx = -nx; ny = -ny; d = -d; }
    return { nx, ny, d };
  });
}

// Where a slot's centre may be on the line y: the x range that keeps CLEAR
// from every edge, or null.
function xRange(edges, y) {
  let lo = -Infinity, hi = Infinity;
  for (const e of edges) {
    const rhs = CLEAR + e.d - e.ny * y;
    if (Math.abs(e.nx) < 1e-9) { if (rhs > 1e-6) return null; continue; }
    const v = rhs / e.nx;
    if (e.nx > 0) lo = Math.max(lo, v); else hi = Math.min(hi, v);
  }
  return lo <= hi + 1e-6 ? [lo, hi] : null;
}

// The lowest line a slot's centre can lie on: the lowest corner of the area
// that keeps CLEAR from every edge. null when no slot fits at all.
function lowestY(edges) {
  let best = null;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      const det = a.nx * b.ny - b.nx * a.ny;
      if (Math.abs(det) < 1e-9) continue;
      const ca = a.d + CLEAR, cb = b.d + CLEAR;
      const x = (ca * b.ny - cb * a.ny) / det;
      const y = (a.nx * cb - b.nx * ca) / det;
      if (edges.every((e) => e.nx * x + e.ny * y - e.d >= CLEAR - 1e-6) && (best === null || y > best)) best = y;
    }
  }
  return best;
}

// A pile in one section: rows from the lowest point up, each row nesting in
// the one below. In fill order, the lowest bottle first.
function pile(poly) {
  const edges = edgesOf(poly);
  const y0 = lowestY(edges);
  if (y0 === null) return [];
  const first = xRange(edges, y0);
  if (!first) return [];
  const n0 = Math.floor((first[1] - first[0]) / PITCH + 1e-6) + 1;
  const start = (first[0] + first[1]) / 2 - (n0 - 1) * PITCH / 2;
  const out = [];
  for (let i = 0; ; i++) {
    const y = y0 - i * ROW_H;
    const r = xRange(edges, y);
    if (!r) break;
    const base = start + (i % 2) * PITCH / 2;
    const jMin = Math.ceil((r[0] - base) / PITCH - 1e-6);
    const jMax = Math.floor((r[1] - base) / PITCH + 1e-6);
    for (let j = jMin; j <= jMax; j++) out.push({ x: base + j * PITCH, y });
  }
  return out;
}

// What each section of a pile box of this pixel size can hold. A wall has a
// handful of distinct box sizes and is laid out on every render, so the piles
// are remembered.
const pileCache = new Map();
function pilesFor(kind, w, h) {
  const key = `${kind}:${w}:${h}`;
  let piles = pileCache.get(key);
  if (!piles) {
    if (pileCache.size > 400) pileCache.clear();
    piles = sectionsOf(kind, INSET, INSET, w - INSET, h - INSET).map(pile);
    pileCache.set(key, piles);
  }
  return piles;
}

const onStep = (v) => Math.ceil(v / CELL_STEP) * CELL_STEP;

// The smallest cell at which this box holds what it says.
const needCache = new Map();
function needCell(box) {
  if (isPile(box.kind)) {
    const key = `${box.kind}:${box.w}:${box.h}:${box.perSection}`;
    let need = needCache.get(key);
    if (need === undefined) {
      if (needCache.size > 400) needCache.clear();
      need = MAX_CELL;
      for (let u = onStep(MIN_CELL); u <= MAX_CELL; u += CELL_STEP) {
        if (pilesFor(box.kind, box.w * u, box.h * u).every((p) => p.length >= box.perSection)) { need = u; break; }
      }
      needCache.set(key, need);
    }
    return need;
  }
  if (box.kind === 'rack') {
    return onStep(Math.max((box.cols * CELL + 2 * INSET + 8) / box.w, (box.rows * CELL + 2 * INSET + 8) / box.h, MIN_CELL));
  }
  if (box.kind === 'shelves') {
    return onStep(Math.max((box.cols * CELL + 2 * INSET + 8) / box.w, (box.rows * (CELL + 12) + 2 * INSET) / box.h, MIN_CELL));
  }
  return onStep(MIN_CELL);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * What a box of this content holds when it is as full as the rest of the
 * wall: the sizes that fit a box of `w` × `h` cells at the wall's cell size
 * without making the wall larger. The builder (components/racks/WallBuilder)
 * offers them when a box gets a new content; the member can change them.
 */
export function fitFor(kind, w, h, cell) {
  const bw = w * cell, bh = h * cell;
  if (isPile(kind)) {
    return { perSection: clamp(Math.min(...pilesFor(kind, bw, bh).map((p) => p.length)), 1, MAX_PER_SECTION) };
  }
  const across = clamp(Math.floor((bw - 2 * INSET - 8) / CELL), 1, MAX_BOX_DIM);
  if (kind === 'rack') return { rows: clamp(Math.floor((bh - 2 * INSET - 8) / CELL), 1, MAX_BOX_DIM), cols: across };
  if (kind === 'shelves') {
    // Shelves with room above the bottles, never more than fit.
    const most = Math.floor((bh - 2 * INSET) / (CELL + 12));
    return { rows: clamp(Math.min(most, Math.round((bh - 2 * INSET) / (CELL * 1.7))), 1, MAX_BOX_DIM), cols: across };
  }
  return {};
}

/** The cell size of a wall whose fullest box is an X of six bottles a triangle: the builder's starting scale. */
export function defaultCell() {
  return needCell({ kind: 'x', w: 1, h: 1, perSection: 6 });
}

/** What identifies a box on screen: its stored id, or the key the builder gave a box not saved yet. */
export const boxKey = (box, index) => String(box._id ?? box.key ?? `box-${index}`);

// Slot centres of a box drawn at cell size `cell`, from its own top-left
// corner, in the contract's order.
function boxSlots(box, cell) {
  const w = box.w * cell, h = box.h * cell;
  if (isPile(box.kind)) {
    return pilesFor(box.kind, w, h).flatMap((p) => {
      const slots = p.slice(0, box.perSection);
      // A pile always fits at the wall's cell size; should one ever not, its
      // last slots share a place instead of leaving positions undrawn.
      while (slots.length < box.perSection) slots.push(slots[slots.length - 1] || { x: w / 2, y: h / 2 });
      return slots;
    });
  }
  const iw = w - 2 * INSET, ih = h - 2 * INSET;
  const out = [];
  if (box.kind === 'rack') {
    const px = Math.min(iw / box.cols, CELL * 1.5), py = Math.min(ih / box.rows, CELL * 1.5);
    const sx = w / 2 - (box.cols - 1) * px / 2, sy = h / 2 - (box.rows - 1) * py / 2;
    for (let r = 0; r < box.rows; r++) for (let c = 0; c < box.cols; c++) out.push({ x: sx + c * px, y: sy + r * py });
  } else if (box.kind === 'shelves') {
    const band = ih / box.rows;
    const px = Math.min(iw / box.cols, CELL * 1.4);
    const sx = w / 2 - (box.cols - 1) * px / 2;
    for (let r = 0; r < box.rows; r++) for (let c = 0; c < box.cols; c++) out.push({ x: sx + c * px, y: INSET + (r + 1) * band - SLOT_R - 6 });
  }
  return out;
}

// The planks inside a box, as lines from its own top-left corner.
function planksOf(box, w, h) {
  const lines = [];
  if (box.kind === 'x' || box.kind === 'backslash') lines.push({ x1: INSET, y1: INSET, x2: w - INSET, y2: h - INSET });
  if (box.kind === 'x' || box.kind === 'slash') lines.push({ x1: w - INSET, y1: INSET, x2: INSET, y2: h - INSET });
  if (box.kind === 'shelves') {
    const band = (h - 2 * INSET) / box.rows;
    for (let r = 1; r < box.rows; r++) lines.push({ x1: INSET, y1: INSET + r * band, x2: w - INSET, y2: INSET + r * band });
  }
  return lines;
}

// The doors of a closed box: one, or a pair when the box is at least two cells wide.
function doorsOf(box, w, h) {
  if (box.kind !== 'closed') return [];
  const count = box.w >= 2 ? 2 : 1;
  const dw = (w - 2 * INSET - 8) / count;
  return Array.from({ length: count }, (_, d) => {
    const x = INSET + 4 + d * dw;
    return {
      x, y: INSET + 4, width: dw - (count > 1 ? 2 : 0), height: h - 2 * INSET - 8,
      knobX: count === 1 || d === 0 ? x + dw - 14 : x + 12, knobY: h / 2,
    };
  });
}

/**
 * Lay out a wall: every slot's centre, and what the renderers draw around the
 * slots (components/racks/WallDecor.js).
 *
 * A box is named by its column letter and row number ("B2"), so the wall
 * carries the letters along its top and the numbers down its left side, like
 * a map; a wall of a single cell needs neither.
 *
 * @returns {{ totalSlots: number, viewBox: { width: number, height: number },
 *   slots: Array<{ position: number, cx: number, cy: number }>,
 *   wall: { cell: number, boxes: Array<object>, emptyCells: Array<object>, axes: Array<object> } }}
 */
export function wallLayout(rows, cols, typeConfig) {
  const boxes = Number.isInteger(rows) && Number.isInteger(cols) ? wallBoxes(rows, cols, typeConfig) : [];
  const cell = boxes.reduce((u, b) => Math.max(u, needCell(b)), onStep(MIN_CELL));
  const safeRows = Number.isInteger(rows) && rows > 0 ? rows : 1;
  const safeCols = Number.isInteger(cols) && cols > 0 ? cols : 1;
  const named = safeRows * safeCols > 1;
  const originX = named ? GUTTER : MARGIN, originY = named ? GUTTER : MARGIN;

  const slots = [];
  const drawn = [];
  const covered = new Set();
  let start = 0;
  boxes.forEach((box, index) => {
    const left = originX + box.x * cell, top = originY + box.y * cell;
    const width = box.w * cell, height = box.h * cell;
    const capacity = boxCapacity(box);
    for (const p of boxSlots(box, cell)) slots.push({ position: slots.length + 1, cx: left + p.x, cy: top + p.y });
    drawn.push({
      key: boxKey(box, index),
      label: boxLabel(box),
      kind: box.kind,
      x: left, y: top, width, height, inset: INSET,
      start, capacity,
      planks: planksOf(box, width, height).map((l) => ({ x1: left + l.x1, y1: top + l.y1, x2: left + l.x2, y2: top + l.y2 })),
      doors: doorsOf(box, width, height).map((d) => ({ ...d, x: left + d.x, y: top + d.y, knobX: left + d.knobX, knobY: top + d.knobY })),
    });
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) covered.add(`${x},${y}`);
    start += capacity;
  });

  const emptyCells = [];
  for (let y = 0; y < safeRows; y++) {
    for (let x = 0; x < safeCols; x++) {
      if (!covered.has(`${x},${y}`)) emptyCells.push({ col: x, row: y, x: originX + x * cell, y: originY + y * cell, size: cell });
    }
  }

  const axes = [];
  if (named) {
    for (let x = 0; x < safeCols; x++) axes.push({ key: `col-${x}`, label: columnLetters(x), x: originX + (x + 0.5) * cell, y: GUTTER / 2 });
    for (let y = 0; y < safeRows; y++) axes.push({ key: `row-${y}`, label: String(y + 1), x: GUTTER / 2, y: originY + (y + 0.5) * cell });
  }

  return {
    totalSlots: slots.length,
    viewBox: { width: originX + safeCols * cell + MARGIN, height: originY + safeRows * cell + MARGIN },
    slots,
    // `origin` is the top-left corner of cell A1, past the letters and numbers.
    // `size` is the cells alone, without the gutter and the margin around them.
    wall: { cell, origin: { x: originX, y: originY }, size: { width: safeCols * cell, height: safeRows * cell }, boxes: drawn, emptyCells, axes },
  };
}
