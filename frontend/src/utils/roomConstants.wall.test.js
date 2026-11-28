import { describe, it, expect } from 'vitest';
import { buildScaledLayout, getRackHeight, getRackWorldDims, PANEL_THICK, BOTTLE_RADIUS } from './roomConstants';
import { wallLayout } from './wallLayout';

// A wall rack in the 3D room. The room takes its slots from the flat drawing
// (utils/wallLayout.js) scaled to metres, and must measure the wall by its
// cells alone: the flat drawing has column letters and row numbers around
// them, and a frame sized to include those would stand off-centre with every
// bottle shifted in it. Plain geometry — no three.js needed.

// A1 an X of six a triangle, B1–C1 a closed box two cells wide, A2 a diagonal,
// B2 shelves, C2 empty wall.
const WALL = {
  type: 'wall', rows: 2, cols: 3,
  typeConfig: { boxes: [
    { _id: 'a', x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
    { _id: 'b', x: 1, y: 0, w: 2, h: 1, kind: 'closed' },
    { _id: 'c', x: 0, y: 1, w: 1, h: 1, kind: 'slash', perSection: 14 },
    { _id: 'd', x: 1, y: 1, w: 1, h: 1, kind: 'shelves', rows: 3, cols: 4 },
  ] },
};
const flat = wallLayout(WALL.rows, WALL.cols, WALL.typeConfig);
const scaled = buildScaledLayout(WALL);
const box = (key) => scaled.wall.boxes.find((b) => b.key === key);
const near = (a, b) => Math.abs(a - b) < 1e-9;

describe('a wall rack scaled into the 3D room', () => {
  it('has every slot of the flat drawing, numbered alike', () => {
    expect(scaled.positions.map((p) => p.position)).toEqual(flat.slots.map((s) => s.position));
    expect(scaled.positions).toHaveLength(24 + 28 + 12);
  });

  it('is as large as its cells, three wide and two high, and centred on them', () => {
    expect(scaled.innerW / scaled.innerH).toBeCloseTo(3 / 2);
    // The flat drawing is wider than its cells: it carries the letters and numbers.
    expect(flat.viewBox.width).toBeGreaterThan(flat.wall.size.width);
    // The boxes reach both edges of the frame exactly.
    expect(near(box('a').cx - box('a').w / 2, -scaled.innerW / 2)).toBe(true);
    expect(near(box('b').cx + box('b').w / 2, scaled.innerW / 2)).toBe(true);
    expect(near(box('a').cy + box('a').h / 2, scaled.innerH / 2)).toBe(true);
    expect(near(box('c').cy - box('c').h / 2, -scaled.innerH / 2)).toBe(true);
  });

  it('keeps every slot inside its own box, with room for the bottle', () => {
    for (const b of flat.wall.boxes) {
      const s3 = box(b.key);
      for (const p of scaled.positions.slice(b.start, b.start + b.capacity)) {
        expect(Math.abs(p.x - s3.cx)).toBeLessThanOrEqual(s3.w / 2 - BOTTLE_RADIUS);
        expect(Math.abs(p.y - s3.cy)).toBeLessThanOrEqual(s3.h / 2 - BOTTLE_RADIUS);
      }
    }
  });

  it('the top row of the flat drawing is the top of the room: an X above a diagonal', () => {
    expect(box('a').cy).toBeGreaterThan(box('c').cy);
    // A pile's first bottle lies lowest, in the room as in the drawing.
    const topPile = scaled.positions.slice(0, 6).map((p) => p.y);
    expect(Math.min(...topPile)).toBe(topPile[0]);
  });

  it('carries the woodwork: two planks in an X, one in a diagonal, one fewer than the shelves, and a pair of doors', () => {
    expect(box('a').planks).toHaveLength(2);
    expect(box('c').planks).toHaveLength(1);
    expect(box('d').planks).toHaveLength(2);
    expect(box('b').doors).toHaveLength(2);
    // A diagonal plank runs from one corner of its box to the opposite one.
    const [p] = box('c').planks;
    expect(Math.hypot(p.x2 - p.x1, p.y2 - p.y1)).toBeGreaterThan(box('c').w);
    // A shelf plank is level, and a door lies within its box.
    for (const s of box('d').planks) expect(near(s.y1, s.y2)).toBe(true);
    for (const d of box('b').doors) expect(Math.abs(d.cx - box('b').cx) + d.w / 2).toBeLessThanOrEqual(box('b').w / 2);
  });

  it('the room sizes the wall by its cells, whatever width was stored for the rack before', () => {
    expect(getRackHeight(WALL)).toBeCloseTo(scaled.innerH + PANEL_THICK * 2);
    const own = getRackWorldDims(WALL, {});
    expect(own.halfW * 2).toBeCloseTo(scaled.innerW + PANEL_THICK * 2);
    expect(getRackWorldDims(WALL, { widthOverride: 9 }).halfW).toBe(own.halfW);
    // Any other rack still takes its override.
    const grid = { type: 'grid', rows: 2, cols: 3 };
    expect(getRackWorldDims(grid, { widthOverride: 9 }).halfW).toBe(4.5);
  });

  it('a rack that is no wall has no woodwork of this kind', () => {
    expect(buildScaledLayout({ type: 'cube', rows: 2, cols: 2, typeConfig: { moduleRows: 2, moduleCols: 2 } }).wall).toBeUndefined();
  });
});
