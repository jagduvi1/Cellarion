/**
 * The moves of the wall builder (components/racks/WallBuilder.js): every way
 * a member can change the boxes of a wall rack before it is saved. Pure
 * functions over a wall as the form holds it, { rows, cols, boxes }, each
 * returning a new wall; nothing here talks to the server.
 *
 * The server's rules for a stored wall (backend utils/wallGeometry.js
 * validateWallConfig) are kept true by construction: a box never leaves the
 * wall, never overlaps another, and always states a size within bounds. The
 * rules of an edit of a wall in use (planWallEdit: a box with bottles is not
 * removed, re-filled with another content or shrunk under a bottle) are what
 * `usageByBox` lets the builder show before the save is tried.
 */
import {
  wallLayout, fitFor, defaultCell, boxKey, boxLabel, boxCapacity, PILE_SECTIONS,
} from './wallLayout';

// The server's bounds for a rack's rows and cols (backend models/Rack.js): a
// wall another client made that large must open here with fields it can keep.
export const WALL_MAX_COLS = 20;
export const WALL_MAX_ROWS = 20;
export const MAX_PER_SECTION = 60;
export const MAX_BOX_DIM = 20;

const isPile = (kind) => Object.prototype.hasOwnProperty.call(PILE_SECTIONS, kind);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const covers = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

let serial = 0;
const freshKey = () => `new-${++serial}`;

/** The key a box is selected and followed by in the builder. */
export const keyOf = (box) => boxKey(box, 0);

/** The box covering a cell, or undefined for empty wall. */
export const boxAt = (wall, x, y) => wall.boxes.find((b) => covers(b, x, y));

/** The box with this key. */
export const findBox = (wall, key) => wall.boxes.find((b) => keyOf(b) === key);

/** The wall's cell size as drawn; an empty wall has the starting scale. */
export function cellOf(wall) {
  return wall.boxes.length > 0 ? wallLayout(wall.rows, wall.cols, { boxes: wall.boxes }).wall.cell : defaultCell();
}

/** The wall a new rack starts as: four X boxes, six bottles a triangle. */
export function newWall() {
  const boxes = [];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) boxes.push({ key: freshKey(), x, y, w: 1, h: 1, kind: 'x', perSection: 6 });
  }
  return { rows: 2, cols: 2, boxes };
}

/** The wall of a stored rack, for editing; the boxes keep their ids. */
export function wallFromRack(rack) {
  return {
    rows: rack.rows,
    cols: rack.cols,
    boxes: (rack.typeConfig?.boxes || []).map((b) => ({ ...b })),
  };
}

// Only what the server stores for a box of this content.
function stored(box) {
  const out = { x: box.x, y: box.y, w: box.w, h: box.h, kind: box.kind };
  if (box._id != null) out._id = String(box._id);
  if (isPile(box.kind)) out.perSection = box.perSection;
  if (box.kind === 'rack' || box.kind === 'shelves') { out.rows = box.rows; out.cols = box.cols; }
  return out;
}

/** The typeConfig a create or update request sends for this wall. */
export const toTypeConfig = (wall) => ({ boxes: wall.boxes.map(stored) });

/** Put a box of one cell on empty wall. Returns { wall, key }; the wall unchanged when the cell is taken. */
export function addBox(wall, x, y, kind) {
  if (x < 0 || y < 0 || x >= wall.cols || y >= wall.rows || boxAt(wall, x, y)) return { wall, key: null };
  // At least the starting scale: beside only closed or small boxes the wall's
  // cell is the smallest there is, and an X would start with one bottle a pile.
  const box = { key: freshKey(), x, y, w: 1, h: 1, kind, ...fitFor(kind, 1, 1, Math.max(cellOf(wall), defaultCell())) };
  return { wall: { ...wall, boxes: [...wall.boxes, box] }, key: box.key };
}

/** Take a box off the wall; its cells become empty wall. */
export const removeBox = (wall, key) => ({ ...wall, boxes: wall.boxes.filter((b) => keyOf(b) !== key) });

const replaceBox = (wall, key, change) => ({
  ...wall,
  boxes: wall.boxes.map((b) => (keyOf(b) === key ? change(b) : b)),
});

/** Give a box another content, holding what fits a box of its size on this wall. */
export function setKind(wall, key, kind) {
  const box = findBox(wall, key);
  if (!box || box.kind === kind) return wall;
  const cell = cellOf(wall);
  return replaceBox(wall, key, (b) => {
    // The sizes of the old content do not carry over to the new one.
    const next = { ...b, kind };
    delete next.perSection;
    delete next.rows;
    delete next.cols;
    return { ...next, ...fitFor(kind, b.w, b.h, cell) };
  });
}

/** Set what a box holds: `field` is perSection, rows or cols. */
export function setHolds(wall, key, field, value) {
  const max = field === 'perSection' ? MAX_PER_SECTION : MAX_BOX_DIM;
  return replaceBox(wall, key, (b) => ({ ...b, [field]: clamp(value, 1, max) }));
}

/**
 * How large a box can be: as wide as the empty wall beside it allows at its
 * present height, and as high as the empty wall below it allows at its
 * present width. A box only ever grows into empty wall.
 */
export function maxSpan(wall, key) {
  const box = findBox(wall, key);
  if (!box) return { w: 1, h: 1 };
  const others = wall.boxes.filter((b) => b !== box);
  const free = (w, h) => box.x + w <= wall.cols && box.y + h <= wall.rows && !others.some((o) => overlap({ ...box, w, h }, o));
  let w = box.w;
  while (free(w + 1, box.h)) w++;
  let h = box.h;
  while (free(box.w, h + 1)) h++;
  return { w, h };
}

/** Make a box cover `w` × `h` cells, as far as the empty wall around it allows. */
export function setSpan(wall, key, w, h) {
  const box = findBox(wall, key);
  if (!box) return wall;
  const others = wall.boxes.filter((b) => b !== box);
  const want = { ...box, w: clamp(w, 1, wall.cols - box.x), h: clamp(h, 1, wall.rows - box.y) };
  return others.some((o) => overlap(want, o)) ? wall : replaceBox(wall, key, () => want);
}

/** The smallest wall that still holds every box. */
export function minGrid(wall) {
  return {
    rows: wall.boxes.reduce((n, b) => Math.max(n, b.y + b.h), 1),
    cols: wall.boxes.reduce((n, b) => Math.max(n, b.x + b.w), 1),
  };
}

/** Change how many cells wide and high the wall is; it never shrinks past a box. */
export function setGrid(wall, rows, cols) {
  const min = minGrid(wall);
  return { ...wall, rows: clamp(rows, min.rows, WALL_MAX_ROWS), cols: clamp(cols, min.cols, WALL_MAX_COLS) };
}

/**
 * What the bottles already in a wall rack hold the builder to, by box key:
 * { bottles, perSection, rows, cols }, the last three being the smallest
 * sizes that still have a place for every bottle (a pile's highest bottle, a
 * rack's last used row and column). A box without bottles has no entry.
 */
export function usageByBox(rack) {
  const used = new Map();
  if (!rack || !Array.isArray(rack.slots) || rack.slots.length === 0) return used;
  const boxes = rack.typeConfig?.boxes || [];
  const drawn = wallLayout(rack.rows, rack.cols, { boxes }).wall.boxes;
  const byKey = new Map(boxes.map((b, i) => [boxKey(b, i), b]));
  for (const { position } of rack.slots) {
    const at = drawn.find((d) => position > d.start && position <= d.start + d.capacity);
    const box = at && byKey.get(at.key);
    if (!box) continue;
    const index = position - at.start - 1;
    const u = used.get(at.key) || { bottles: 0, perSection: 1, rows: 1, cols: 1 };
    u.bottles += 1;
    if (isPile(box.kind)) u.perSection = Math.max(u.perSection, (index % box.perSection) + 1);
    else {
      u.rows = Math.max(u.rows, Math.floor(index / box.cols) + 1);
      u.cols = Math.max(u.cols, (index % box.cols) + 1);
    }
    used.set(at.key, u);
  }
  return used;
}

export { boxLabel, boxCapacity };
