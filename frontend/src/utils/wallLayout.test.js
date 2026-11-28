/**
 * The drawing of a 'wall' rack against the server's counting of it.
 *
 * WHY THIS TEST EXISTS:
 * The server numbers a wall's slots (backend utils/wallGeometry.js) and this
 * side draws them (utils/wallLayout.js); neither calls the other. A slot the
 * server counts and the page does not draw is a bottle nobody can find, and a
 * slot drawn in another box than the server means is a bottle shown in the
 * wrong bin. So both run the same cases file, the counting halves are
 * compared on walls made up here, and the drawing is held to the two things
 * the position contract promises: a box's slots lie inside that box, and a
 * pile's slots lie inside their own section, the lowest one first.
 */
import { describe, test, expect } from 'vitest';
import backendWall from '../../../backend/src/utils/wallGeometry.js';
import caseFile from '../../../backend/src/utils/wallGeometry.cases.json';
import {
  wallLayout, wallTotalSlots, wallBoxes, boxCapacity, boxLabel, wallPlace, slotPlace, BOX_KINDS, PILE_SECTIONS, SECTION_NAMES,
  WALL_MAX_SLOTS,
} from './wallLayout';
import { computeLayout, getTotalSlots, SLOT_RADIUS, CELL_SIZE, minSlotDistance } from './rackLayouts';

const { cases } = caseFile;

// A wall with one box of every content, the pile boxes of several sizes.
const everyKind = (perSection) => ({
  rows: 2,
  cols: 4,
  boxes: [
    { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection },
    { x: 1, y: 0, w: 1, h: 1, kind: 'slash', perSection },
    { x: 2, y: 0, w: 1, h: 1, kind: 'backslash', perSection },
    { x: 3, y: 0, w: 1, h: 1, kind: 'bin', perSection },
    { x: 0, y: 1, w: 2, h: 1, kind: 'shelves', rows: 2, cols: 7 },
    { x: 2, y: 1, w: 1, h: 1, kind: 'rack', rows: 3, cols: 3 },
    { x: 3, y: 1, w: 1, h: 1, kind: 'closed' },
  ],
});

describe('the drawing counts a wall as the server does', () => {
  test.each(cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    const typeConfig = { boxes: c.boxes };
    const layout = wallLayout(c.rows, c.cols, typeConfig);
    expect(layout.totalSlots).toBe(c.total);
    expect(wallTotalSlots(c.rows, c.cols, typeConfig)).toBe(c.total);
    expect(layout.slots.map((s) => s.position)).toEqual(Array.from({ length: c.total }, (_, i) => i + 1));
    expect(layout.wall.boxes.map((b) => [b.label, b.start, b.capacity])).toEqual(c.ranges);
  });

  test('the two sides share the box contents, the piles of each and the order of the boxes', () => {
    expect(BOX_KINDS).toEqual(backendWall.BOX_KINDS);
    expect(PILE_SECTIONS).toEqual(backendWall.PILE_SECTIONS);
    for (const perSection of [1, 6, 14, 37, 60]) {
      const w = everyKind(perSection);
      const config = { boxes: w.boxes };
      expect(wallTotalSlots(w.rows, w.cols, config)).toBe(backendWall.wallTotalSlots(w.rows, w.cols, config));
      expect(wallBoxes(w.rows, w.cols, config).map(boxLabel)).toEqual(backendWall.wallBoxes(w.rows, w.cols, config).map(backendWall.boxLabel));
      for (const b of w.boxes) expect(boxCapacity(b)).toBe(backendWall.boxCapacity(b));
    }
  });

  test('a position is told as the same box and spot on both sides, for every slot of every case', () => {
    expect(SECTION_NAMES).toEqual(backendWall.SECTION_NAMES);
    for (const c of [...cases, everyKind(7)]) {
      const config = { boxes: c.boxes };
      const total = wallTotalSlots(c.rows, c.cols, config);
      for (let position = 0; position <= total + 1; position++) {
        expect(wallPlace(c.rows, c.cols, config, position)).toEqual(backendWall.wallPlace(c.rows, c.cols, config, position));
      }
    }
    const w = everyKind(7);
    const rack = { type: 'wall', rows: w.rows, cols: w.cols, typeConfig: { boxes: w.boxes } };
    expect(slotPlace(rack, 8)).toEqual({ box: 'A1', kind: 'x', section: 'left', slot: 1, row: null, col: null });
    expect(slotPlace({ ...rack, type: 'grid' }, 8)).toBeNull();
    expect(slotPlace(null, 8)).toBeNull();
  });

  test('the layout engine every rack view calls knows the wall', () => {
    const c = cases[0];
    expect(getTotalSlots('wall', c.rows, c.cols, { boxes: c.boxes })).toBe(c.total);
    expect(computeLayout('wall', c.rows, c.cols, { boxes: c.boxes }).totalSlots).toBe(c.total);
  });
});

describe('where the slots of a wall are drawn', () => {
  const insideBy = (p, box, margin) => p.cx >= box.x + margin && p.cx <= box.x + box.width - margin
    && p.cy >= box.y + margin && p.cy <= box.y + box.height - margin;

  test.each([1, 6, 14, 37, 60])('with %i bottles a pile, every slot lies inside its own box and no two overlap', (perSection) => {
    const w = everyKind(perSection);
    const layout = wallLayout(w.rows, w.cols, { boxes: w.boxes });
    for (const box of layout.wall.boxes) {
      const own = layout.slots.slice(box.start, box.start + box.capacity);
      expect(own).toHaveLength(box.capacity);
      for (const s of own) expect(insideBy(s, box, SLOT_RADIUS)).toBe(true);
    }
    // Circles of one radius that do not overlap have centres at least two radii apart.
    expect(minSlotDistance(layout.slots)).toBeGreaterThanOrEqual(2 * SLOT_RADIUS);
  });

  test('the slots of an X lie in the triangle the contract names, top, left, right, bottom', () => {
    const layout = wallLayout(1, 1, { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }] });
    const [box] = layout.wall.boxes;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const side = (s) => {
      const dx = s.cx - cx, dy = s.cy - cy;
      if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? 'top' : 'bottom';
      return dx < 0 ? 'left' : 'right';
    };
    const sides = layout.slots.map(side);
    expect(sides.slice(0, 6).every((x) => x === 'top')).toBe(true);
    expect(sides.slice(6, 12).every((x) => x === 'left')).toBe(true);
    expect(sides.slice(12, 18).every((x) => x === 'right')).toBe(true);
    expect(sides.slice(18, 24).every((x) => x === 'bottom')).toBe(true);
  });

  test('a diagonal box keeps its two halves apart: a slash is upper left then lower right, a backslash upper right then lower left', () => {
    for (const [kind, firstIsLeft] of [['slash', true], ['backslash', false]]) {
      const layout = wallLayout(1, 1, { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind, perSection: 10 }] });
      const [box] = layout.wall.boxes;
      // Above the plank or below it: the plank runs corner to corner.
      const aboveSlash = (s) => (s.cx - box.x) + (s.cy - box.y) < box.width;
      const aboveBackslash = (s) => (s.cx - box.x) > (s.cy - box.y);
      const above = kind === 'slash' ? aboveSlash : aboveBackslash;
      expect(layout.slots.slice(0, 10).every(above)).toBe(true);
      expect(layout.slots.slice(10).every((s) => !above(s))).toBe(true);
      expect(firstIsLeft).toBe(kind === 'slash');
    }
  });

  test('a pile fills from the bottom: no slot of a pile lies lower than the one before it', () => {
    const layout = wallLayout(1, 3, {
      boxes: [
        { x: 0, y: 0, w: 1, h: 1, kind: 'bin', perSection: 20 },
        { x: 1, y: 0, w: 1, h: 1, kind: 'slash', perSection: 14 },
        { x: 2, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
      ],
    });
    const piles = [[0, 20], [20, 34], [34, 48], [48, 54], [54, 60], [60, 66], [66, 72]];
    for (const [from, to] of piles) {
      const ys = layout.slots.slice(from, to).map((s) => s.cy);
      for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-6);
    }
  });

  test('a rack box and shelves are numbered row by row from the top left', () => {
    const layout = wallLayout(1, 2, {
      boxes: [
        { x: 0, y: 0, w: 1, h: 1, kind: 'rack', rows: 2, cols: 3 },
        { x: 1, y: 0, w: 1, h: 1, kind: 'shelves', rows: 2, cols: 3 },
      ],
    });
    for (const from of [0, 6]) {
      const s = layout.slots.slice(from, from + 6);
      expect(s[0].cx).toBeLessThan(s[1].cx);
      expect(s[1].cx).toBeLessThan(s[2].cx);
      expect(s[0].cy).toBeCloseTo(s[2].cy);
      expect(s[3].cy).toBeGreaterThan(s[0].cy);
      expect(s[3].cx).toBeCloseTo(s[0].cx);
    }
  });

  test('the wall is true to scale: the cell follows the fullest box, and a square of six a triangle holds fourteen a half', () => {
    const six = wallLayout(1, 2, {
      boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }, { x: 1, y: 0, w: 1, h: 1, kind: 'slash', perSection: 14 }],
    });
    const alone = wallLayout(1, 1, { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }] });
    expect(six.wall.cell).toBe(alone.wall.cell);
    const fuller = wallLayout(1, 2, {
      boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }, { x: 1, y: 0, w: 1, h: 1, kind: 'slash', perSection: 30 }],
    });
    expect(fuller.wall.cell).toBeGreaterThan(alone.wall.cell);
    expect(fuller.wall.boxes[0].width).toBe(fuller.wall.boxes[1].width);
  });

  test('a box that covers several cells is drawn that large, and the cells no box covers are listed as empty wall', () => {
    const layout = wallLayout(2, 3, {
      boxes: [{ x: 0, y: 0, w: 2, h: 2, kind: 'rack', rows: 4, cols: 4 }, { x: 2, y: 0, w: 1, h: 1, kind: 'closed' }],
    });
    const [big, door] = layout.wall.boxes;
    expect(big.width).toBe(2 * layout.wall.cell);
    expect(big.height).toBe(2 * layout.wall.cell);
    expect(door.doors).toHaveLength(1);
    expect(layout.wall.emptyCells.map((c) => `${c.col},${c.row}`)).toEqual(['2,1']);
    expect(layout.viewBox.width).toBeGreaterThan(3 * layout.wall.cell);
  });

  test('a closed box two cells wide has a pair of doors, an X two planks, a diagonal one, shelves one plank fewer than shelves', () => {
    const layout = wallLayout(1, 6, {
      boxes: [
        { x: 0, y: 0, w: 2, h: 1, kind: 'closed' },
        { x: 2, y: 0, w: 1, h: 1, kind: 'x', perSection: 3 },
        { x: 3, y: 0, w: 1, h: 1, kind: 'slash', perSection: 3 },
        { x: 4, y: 0, w: 1, h: 1, kind: 'shelves', rows: 3, cols: 2 },
        { x: 5, y: 0, w: 1, h: 1, kind: 'bin', perSection: 3 },
      ],
    });
    const by = Object.fromEntries(layout.wall.boxes.map((b) => [b.kind, b]));
    expect(by.closed.doors).toHaveLength(2);
    expect(by.x.planks).toHaveLength(2);
    expect(by.slash.planks).toHaveLength(1);
    expect(by.shelves.planks).toHaveLength(2);
    expect(by.bin.planks).toHaveLength(0);
  });

  test('the wall carries its column letters along the top and its row numbers down the side, clear of every box; a single cell carries none', () => {
    const layout = wallLayout(2, 3, { boxes: [{ x: 0, y: 0, w: 3, h: 2, kind: 'bin', perSection: 30 }] });
    expect(layout.wall.axes.map((a) => a.label)).toEqual(['A', 'B', 'C', '1', '2']);
    const [box] = layout.wall.boxes;
    for (const a of layout.wall.axes) expect(a.x < box.x || a.y < box.y).toBe(true);
    expect(wallLayout(1, 1, { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }] }).wall.axes).toEqual([]);
  });

  test('a wall with nothing valid in it still has a size, and no slots', () => {
    for (const config of [undefined, {}, { boxes: [] }, { boxes: [{ kind: 'x' }] }]) {
      const layout = wallLayout(2, 2, config);
      expect(layout.totalSlots).toBe(0);
      expect(layout.viewBox.width).toBeGreaterThan(0);
      expect(layout.wall.emptyCells).toHaveLength(4);
    }
  });

  test('the wall draws its slots at the size every other rack does', () => {
    // utils/wallLayout.js keeps its own copy of these two numbers.
    expect(SLOT_RADIUS).toBe(20);
    expect(CELL_SIZE).toBe(48);
  });
});

describe('a box that states no valid size', () => {
  // The server counts such a box as holding nothing. Drawn all the same, its
  // slots would take the numbers of the boxes after it, and every bottle
  // there would be shown in the wrong place.
  const good = { x: 1, y: 0, w: 1, h: 1, kind: 'bin', perSection: 5 };
  test.each([
    ['an X with no size', { x: 0, y: 0, w: 1, h: 1, kind: 'x' }],
    ['a size given as text', { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: '6' }],
    ['a pile past the limit', { x: 0, y: 0, w: 1, h: 1, kind: 'slash', perSection: 61 }],
    ['a rack with no rows', { x: 0, y: 0, w: 1, h: 1, kind: 'rack', cols: 4 }],
  ])('%s is drawn empty, and the box after it keeps its numbers', (_name, bad) => {
    const typeConfig = { boxes: [bad, good] };
    const layout = wallLayout(1, 2, typeConfig);
    expect(backendWall.wallTotalSlots(1, 2, typeConfig)).toBe(5);
    expect(layout.totalSlots).toBe(5);
    expect(layout.slots.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
    for (const s of layout.slots) {
      expect(Number.isFinite(s.cx) && Number.isFinite(s.cy)).toBe(true);
      expect(s.cx).toBeGreaterThan(layout.wall.origin.x + layout.wall.cell);
    }
    expect(layout.wall.cell).toBeLessThan(400);
  });

  test('the most a wall may hold is the server\'s number', () => {
    expect(WALL_MAX_SLOTS).toBe(backendWall.WALL_MAX_SLOTS);
  });
});
