/**
 * The moves of the wall builder.
 *
 * WHY THIS TEST EXISTS:
 * The builder lets a member shape a wall freely, and the server refuses a
 * wall that is not valid (a box outside the wall, two boxes on one cell, a
 * size out of bounds). A refusal after a long session of building is the
 * worst moment to learn a rule, so every move here must keep the wall valid
 * by construction; these tests check each move against the server's own
 * validator. They also pin what a wall in use allows, so the builder can say
 * it before the save is tried.
 */
import { describe, test, expect } from 'vitest';
import backendWall from '../../../backend/src/utils/wallGeometry.js';
import {
  newWall, wallFromRack, toTypeConfig, addBox, removeBox, setKind, setHolds, setSpan, maxSpan,
  setGrid, minGrid, boxAt, findBox, keyOf, cellOf, usageByBox, WALL_MAX_COLS, WALL_MAX_ROWS,
} from './wallEdit';
import { wallLayout, BOX_KINDS, defaultCell } from './wallLayout';

const valid = (wall) => backendWall.validateWallConfig(toTypeConfig(wall), 'wall', wall.rows, wall.cols, false);
const keyAt = (wall, x, y) => keyOf(boxAt(wall, x, y));

describe('building a wall', () => {
  test('a new wall is four X boxes of six a triangle, and the server takes it', () => {
    const wall = newWall();
    expect(wall).toMatchObject({ rows: 2, cols: 2 });
    expect(wall.boxes.map((b) => [b.x, b.y, b.kind, b.perSection])).toEqual([[0, 0, 'x', 6], [1, 0, 'x', 6], [0, 1, 'x', 6], [1, 1, 'x', 6]]);
    expect(new Set(wall.boxes.map(keyOf)).size).toBe(4);
    expect(valid(wall)).toBeNull();
    expect(cellOf(wall)).toBe(defaultCell());
  });

  test('what is sent to the server holds each content\'s own sizes and nothing of the builder', () => {
    let wall = setGrid(newWall(), 2, 3);
    wall = addBox(wall, 2, 0, 'rack').wall;
    wall = addBox(wall, 2, 1, 'closed').wall;
    const boxes = toTypeConfig(wall).boxes;
    expect(boxes[0]).toEqual({ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 });
    expect(Object.keys(boxes[4]).sort()).toEqual(['cols', 'h', 'kind', 'rows', 'w', 'x', 'y']);
    expect(boxes[5]).toEqual({ x: 2, y: 1, w: 1, h: 1, kind: 'closed' });
  });

  test.each(BOX_KINDS)('a box of every content can be added to empty wall and fits without making the wall larger: %s', (kind) => {
    const start = setGrid(newWall(), 2, 3);
    const cell = cellOf(start);
    const { wall, key } = addBox(start, 2, 0, kind);
    expect(key).not.toBeNull();
    expect(findBox(wall, key)).toMatchObject({ x: 2, y: 0, w: 1, h: 1, kind });
    expect(valid(wall)).toBeNull();
    expect(cellOf(wall)).toBe(cell);
  });

  test('a box is not added on a cell another box covers, or outside the wall', () => {
    const wall = newWall();
    expect(addBox(wall, 0, 0, 'bin')).toEqual({ wall, key: null });
    expect(addBox(wall, 2, 0, 'bin')).toEqual({ wall, key: null });
  });

  test('a box given another content holds what fits it, and the sizes of the old content are gone', () => {
    const wall = newWall();
    const key = keyAt(wall, 0, 0);
    const asRack = setKind(wall, key, 'rack');
    const rack = findBox(asRack, key);
    expect(rack.perSection).toBeUndefined();
    expect(rack.rows).toBeGreaterThan(1);
    expect(rack.cols).toBeGreaterThan(1);
    expect(valid(asRack)).toBeNull();
    expect(cellOf(asRack)).toBe(cellOf(wall));

    const asHalf = setKind(asRack, key, 'slash');
    expect(findBox(asHalf, key)).toMatchObject({ kind: 'slash' });
    expect(findBox(asHalf, key).rows).toBeUndefined();
    // In a square that holds six a triangle, half of a diagonal box holds fourteen.
    expect(findBox(asHalf, key).perSection).toBe(14);
    expect(setKind(wall, key, 'x')).toBe(wall);
  });

  test('what a box holds stays within the bounds the server has', () => {
    const wall = newWall();
    const key = keyAt(wall, 0, 0);
    expect(findBox(setHolds(wall, key, 'perSection', 500), key).perSection).toBe(60);
    expect(findBox(setHolds(wall, key, 'perSection', 0), key).perSection).toBe(1);
    const rack = setKind(wall, key, 'rack');
    expect(findBox(setHolds(rack, key, 'rows', 99), key).rows).toBe(20);
    expect(valid(setHolds(rack, key, 'cols', 99))).toBeNull();
  });

  test('a box grows only into empty wall', () => {
    // 3 × 3 with the four X boxes in the top left corner.
    const wall = setGrid(newWall(), 3, 3);
    const corner = keyAt(wall, 0, 0);
    expect(maxSpan(wall, corner)).toEqual({ w: 1, h: 1 });
    expect(setSpan(wall, corner, 2, 1)).toBe(wall);

    const right = keyAt(wall, 1, 0);
    expect(maxSpan(wall, right)).toEqual({ w: 2, h: 1 });
    const wider = setSpan(wall, right, 2, 1);
    expect(findBox(wider, right)).toMatchObject({ x: 1, y: 0, w: 2, h: 1 });
    expect(valid(wider)).toBeNull();

    // Once the box below it is gone, it can grow downwards as well.
    const freed = removeBox(wider, keyAt(wider, 1, 1));
    expect(maxSpan(freed, right)).toEqual({ w: 2, h: 3 });
    const tall = setSpan(freed, right, 2, 3);
    expect(findBox(tall, right)).toMatchObject({ w: 2, h: 3 });
    expect(valid(tall)).toBeNull();
    expect(setSpan(tall, right, 9, 9)).toEqual(tall);
  });

  test('the wall grows and shrinks, but never past a box', () => {
    const wall = newWall();
    expect(minGrid(wall)).toEqual({ rows: 2, cols: 2 });
    expect(setGrid(wall, 1, 1)).toMatchObject({ rows: 2, cols: 2 });
    expect(setGrid(wall, 99, 99)).toMatchObject({ rows: WALL_MAX_ROWS, cols: WALL_MAX_COLS });
    const smaller = removeBox(removeBox(wall, keyAt(wall, 1, 0)), keyAt(wall, 1, 1));
    expect(setGrid(smaller, 2, 1)).toMatchObject({ rows: 2, cols: 1 });
    expect(valid(setGrid(smaller, 2, 1))).toBeNull();
  });

  test('a removed box leaves empty wall, and the last box can go too', () => {
    let wall = newWall();
    wall = removeBox(wall, keyAt(wall, 0, 0));
    expect(boxAt(wall, 0, 0)).toBeUndefined();
    expect(wallLayout(wall.rows, wall.cols, { boxes: wall.boxes }).wall.emptyCells.map((c) => `${c.col},${c.row}`)).toEqual(['0,0']);
    for (const b of wall.boxes) wall = removeBox(wall, keyOf(b));
    expect(wall.boxes).toEqual([]);
    expect(cellOf(wall)).toBe(defaultCell());
    // The server refuses a wall that holds nothing; the form says so before sending.
    expect(valid(wall)).toMatch(/at least one box/);
  });
});

describe('a wall in use', () => {
  // A1 an X of six a triangle (positions 1–24), B1 a rack of 3 × 4 (25–36).
  const rack = {
    type: 'wall', rows: 1, cols: 2,
    typeConfig: { boxes: [
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
    ] },
    slots: [{ position: 3 }, { position: 10 }, { position: 30 }],
  };

  test('the builder edits the stored boxes and sends their ids back', () => {
    const wall = wallFromRack(rack);
    expect(wall.boxes.map(keyOf)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(toTypeConfig(wall).boxes.map((b) => b._id)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(wall.boxes[0]).not.toBe(rack.typeConfig.boxes[0]);
    expect(valid(wall)).toBeNull();
  });

  test('each box knows how many bottles lie in it and how small it may become', () => {
    const used = usageByBox(rack);
    // Position 3 is the third bottle of the first pile, position 10 the fourth of the second.
    expect(used.get('aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({ bottles: 2, perSection: 4, rows: 1, cols: 1 });
    // Position 30 is the rack's second row, second column.
    expect(used.get('bbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ bottles: 1, perSection: 1, rows: 2, cols: 2 });
  });

  test('the sizes the builder allows are the ones the server accepts for the bottles there', () => {
    const used = usageByBox(rack);
    const before = { rows: rack.rows, cols: rack.cols, typeConfig: rack.typeConfig };
    const edit = (change) => {
      const wall = wallFromRack(rack);
      change(wall.boxes);
      return backendWall.planWallEdit(before, { rows: wall.rows, cols: wall.cols, typeConfig: toTypeConfig(wall) }, { bottles: rack.slots.map((s) => s.position) });
    };
    const x = used.get('aaaaaaaaaaaaaaaaaaaaaaaa'), r = used.get('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(edit((b) => { b[0].perSection = x.perSection; b[1].rows = r.rows; b[1].cols = r.cols; }).error).toBeUndefined();
    expect(edit((b) => { b[0].perSection = x.perSection - 1; }).error).toMatch(/box A1/);
    expect(edit((b) => { b[1].cols = r.cols - 1; }).error).toMatch(/box B1/);
  });

  test('an empty rack, or one that is no wall, holds the builder to nothing', () => {
    expect(usageByBox({ ...rack, slots: [] }).size).toBe(0);
    expect(usageByBox(null).size).toBe(0);
  });
});
