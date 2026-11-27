/**
 * The 'wall' rack type: counting its slots, refusing a wall that cannot be
 * stored, and keeping every bottle in its box when the wall is edited.
 *
 * WHY THIS TEST EXISTS:
 * A wall's positions run box after box, so adding, resizing or removing one
 * box renumbers every box after it. If the edit did not carry the bottles
 * along, a member who adds one box to their wall would find every later
 * bottle in the wrong bin, with nothing on screen saying so. planWallEdit is
 * the one place that decides where each numbered position goes; these tests
 * pin its rules. The counting cases are shared with the drawing (frontend
 * utils/wallLayout.test.js runs the same file), because a slot the server
 * counts and the page does not draw is a bottle nobody can find.
 */
const {
  BOX_KINDS, boxCapacity, wallBoxes, wallTotalSlots, wallRanges, boxLabel,
  validateWallConfig, planWallEdit, WALL_MAX_SLOTS,
} = require('./wallGeometry');
const { totalSlots, getMaxPosition } = require('./rackGeometry');
const { cases } = require('./wallGeometry.cases.json');

const id = (n) => String(n).padStart(24, '0');
const box = (n, x, y, kind, extra = {}) => ({ _id: id(n), x, y, w: 1, h: 1, kind, ...extra });
const wall = (rows, cols, boxes) => ({ rows, cols, typeConfig: { boxes } });

describe('counting a wall', () => {
  test.each(cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    const typeConfig = { boxes: c.boxes };
    expect(wallTotalSlots(c.rows, c.cols, typeConfig)).toBe(c.total);
    expect(wallRanges(c.rows, c.cols, typeConfig).map((r) => [r.label, r.start, r.capacity])).toEqual(c.ranges);
  });

  test('the rack functions every caller uses count a wall the same way', () => {
    const c = cases[0];
    expect(totalSlots('wall', c.rows, c.cols, { boxes: c.boxes })).toBe(c.total);
    expect(getMaxPosition({ type: 'wall', rows: c.rows, cols: c.cols, typeConfig: { boxes: c.boxes } })).toBe(c.total);
  });

  test('a box holds what its content says', () => {
    expect(boxCapacity({ kind: 'x', perSection: 6 })).toBe(24);
    expect(boxCapacity({ kind: 'slash', perSection: 15 })).toBe(30);
    expect(boxCapacity({ kind: 'backslash', perSection: 15 })).toBe(30);
    expect(boxCapacity({ kind: 'bin', perSection: 20 })).toBe(20);
    expect(boxCapacity({ kind: 'rack', rows: 4, cols: 3 })).toBe(12);
    expect(boxCapacity({ kind: 'shelves', rows: 3, cols: 8 })).toBe(24);
    expect(boxCapacity({ kind: 'closed' })).toBe(0);
    expect(boxCapacity({ kind: 'x' })).toBe(0);
    expect(boxCapacity({ kind: 'rack', rows: 2.5, cols: 3 })).toBe(0);
    expect(BOX_KINDS).toEqual(['x', 'slash', 'backslash', 'bin', 'rack', 'shelves', 'closed']);
  });

  test('boxes are taken top to bottom, then left to right, whatever order they are stored in', () => {
    const boxes = [box(1, 1, 1, 'bin', { perSection: 1 }), box(2, 0, 1, 'bin', { perSection: 1 }), box(3, 1, 0, 'bin', { perSection: 1 }), box(4, 0, 0, 'bin', { perSection: 1 })];
    expect(wallBoxes(2, 2, { boxes }).map(boxLabel)).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  test('a column past Z gets two letters', () => {
    expect(boxLabel({ x: 25, y: 0 })).toBe('Z1');
    expect(boxLabel({ x: 26, y: 4 })).toBe('AA5');
  });

  test('a wall with no boxes list holds nothing', () => {
    expect(wallTotalSlots(3, 3, {})).toBe(0);
    expect(wallTotalSlots(3, 3, undefined)).toBe(0);
    expect(wallTotalSlots(3, 3, { boxes: 'x' })).toBe(0);
  });
});

describe('a wall a request may store', () => {
  const ok = [box(1, 0, 0, 'x', { perSection: 6 }), box(2, 1, 0, 'closed')];
  const problem = (boxes, rows = 1, cols = 2) => validateWallConfig({ boxes }, 'wall', rows, cols, false);

  test('a valid wall passes', () => {
    expect(problem(ok)).toBeNull();
    expect(validateWallConfig({ boxes: cases[0].boxes }, 'wall', 3, 4, false)).toBeNull();
  });

  test('boxes on any other rack type are refused, and a rack without them is left alone', () => {
    expect(validateWallConfig({ boxes: ok }, 'grid', 1, 2, false)).toMatch(/only supported on a wall/);
    expect(validateWallConfig({ boxes: ok }, 'wall', 1, 2, true)).toMatch(/only supported on a wall/);
    expect(validateWallConfig({ bottlesPerSection: 10 }, 'x-rack', 1, 1, false)).toBeNull();
    expect(validateWallConfig(undefined, 'grid', 4, 8, false)).toBeNull();
  });

  test('a wall needs boxes, and one of them must hold bottles', () => {
    expect(validateWallConfig({}, 'wall', 1, 2, false)).toMatch(/at least one box/);
    expect(problem([])).toMatch(/at least one box/);
    expect(problem([box(1, 0, 0, 'closed'), box(2, 1, 0, 'closed')])).toMatch(/holds bottles/);
  });

  test('a box must lie inside the wall and overlap no other box', () => {
    expect(problem([box(1, 1, 0, 'x', { perSection: 6, w: 2 })])).toMatch(/inside the wall/);
    expect(problem([box(1, 0, 1, 'x', { perSection: 6 })])).toMatch(/inside the wall/);
    expect(problem([box(1, 0, 0, 'x', { perSection: 6, w: 1.5 })])).toMatch(/inside the wall/);
    expect(problem([box(1, 0, 0, 'x', { perSection: 6, w: 2 }), box(2, 1, 0, 'closed')])).toMatch(/Box B1 overlaps another box/);
  });

  test('each content states its size within its bounds', () => {
    expect(problem([box(1, 0, 0, 'x')])).toMatch(/Box A1: perSection/);
    expect(problem([box(1, 0, 0, 'bin', { perSection: 61 })])).toMatch(/between 1 and 60/);
    expect(problem([box(1, 0, 0, 'rack', { rows: 3 })])).toMatch(/Box A1: rows and cols/);
    expect(problem([box(1, 0, 0, 'shelves', { rows: 21, cols: 3 })])).toMatch(/between 1 and 20/);
    expect(problem([{ ...ok[0], kind: 'barrel' }])).toMatch(/Invalid box kind/);
    expect(problem([null])).toMatch(/must be an object/);
  });

  test('a box id is a real id and belongs to one box', () => {
    expect(problem([{ ...ok[0], _id: 'B2' }])).toMatch(/not a valid id/);
    expect(problem([ok[0], { ...ok[1], _id: ok[0]._id }])).toMatch(/share one _id/);
    expect(problem([{ x: 0, y: 0, w: 1, h: 1, kind: 'bin', perSection: 3 }])).toBeNull();
  });

  test('a wall holds no more slots than a rack may', () => {
    const boxes = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) boxes.push({ x, y, w: 1, h: 1, kind: 'rack', rows: 6, cols: 6 });
    expect(validateWallConfig({ boxes }, 'wall', 20, 20, false)).toMatch(new RegExp(`at most ${WALL_MAX_SLOTS} slots`));
  });
});

describe('editing a wall keeps every bottle in its box', () => {
  // A1 an X of 6 (positions 1–24), B1 a rack of 3 × 4 (25–36), C1 a bin of 10 (37–46).
  const before = wall(1, 3, [
    box(1, 0, 0, 'x', { perSection: 6 }),
    box(2, 1, 0, 'rack', { rows: 3, cols: 4 }),
    box(3, 2, 0, 'bin', { perSection: 10 }),
  ]);
  const edited = (change) => {
    const boxes = before.typeConfig.boxes.map((b) => ({ ...b }));
    const out = wall(before.rows, before.cols, boxes);
    change(out, boxes);
    return out;
  };

  test('an edit that changes nothing moves nothing', () => {
    const plan = planWallEdit(before, edited(() => {}), { bottles: [1, 24, 25, 36, 46], marked: [2] });
    expect([...plan.move]).toEqual([[1, 1], [24, 24], [25, 25], [36, 36], [46, 46], [2, 2]]);
    expect(plan.dropped.size).toBe(0);
  });

  test('a bigger pile shifts every box after it, and each bottle keeps its pile and its count from the bottom', () => {
    // The X goes from 6 to 8 a triangle: its second triangle starts at 9, not 7.
    const after = edited((w, boxes) => { boxes[0].perSection = 8; });
    const plan = planWallEdit(before, after, { bottles: [1, 6, 7, 24, 25, 46] });
    expect(Object.fromEntries(plan.move)).toEqual({ 1: 1, 6: 6, 7: 9, 24: 30, 25: 33, 46: 54 });
  });

  test('a new box in front renumbers the boxes behind it, bottles included', () => {
    const after = edited((w, boxes) => {
      w.rows = 2;
      boxes.forEach((b) => { b.y = 1; });
      boxes.push({ x: 0, y: 0, w: 3, h: 1, kind: 'shelves', rows: 2, cols: 10 });
    });
    const plan = planWallEdit(before, after, { bottles: [1, 25, 46], marked: [3, 40] });
    expect(Object.fromEntries(plan.move)).toEqual({ 1: 21, 25: 45, 46: 66, 3: 23, 40: 60 });
  });

  test('boxes that swap places keep their bottles', () => {
    const after = edited((w, boxes) => { boxes[0].x = 2; boxes[2].x = 0; });
    const plan = planWallEdit(before, after, { bottles: [1, 37] });
    // The bin is now first (1–10), the rack second (11–22), the X last (23–46).
    expect(Object.fromEntries(plan.move)).toEqual({ 1: 23, 37: 1 });
  });

  test('a rack box keeps each bottle in its row and column when it grows', () => {
    const after = edited((w, boxes) => { boxes[1].cols = 6; boxes[1].rows = 4; });
    // Position 30 is the rack's row 2, column 2 (0-based 1, 1): with 6 columns that is its 8th slot.
    const plan = planWallEdit(before, after, { bottles: [25, 30, 36, 37] });
    expect(Object.fromEntries(plan.move)).toEqual({ 25: 25, 30: 32, 36: 40, 37: 49 });
  });

  test('a box cannot shrink under a bottle', () => {
    const smallerPile = edited((w, boxes) => { boxes[2].perSection = 4; });
    expect(planWallEdit(before, smallerPile, { bottles: [37, 40] }).error).toBeUndefined();
    expect(planWallEdit(before, smallerPile, { bottles: [41] }).error)
      .toBe('Cannot change the wall: box C1 would no longer have the place of 1 bottle(s) in it. Move those bottles out first.');
    const narrowerRack = edited((w, boxes) => { boxes[1].cols = 3; });
    expect(planWallEdit(before, narrowerRack, { bottles: [27] }).error).toBeUndefined();
    expect(planWallEdit(before, narrowerRack, { bottles: [28, 32] }).error).toMatch(/box B1 would no longer have the place of 2 bottle/);
  });

  test('a box holding bottles cannot be removed or given another content', () => {
    const removed = edited((w, boxes) => { boxes.splice(1, 1); });
    expect(planWallEdit(before, removed, { bottles: [26, 27] }).error)
      .toBe('Cannot change the wall: box B1 holds 2 bottle(s) and would be removed. Move those bottles out first.');
    const retyped = edited((w, boxes) => { boxes[0].kind = 'slash'; boxes[0].perSection = 12; });
    expect(planWallEdit(before, retyped, { bottles: [5] }).error).toMatch(/box A1 holds 1 bottle\(s\) and would get another content/);
  });

  test('an empty box can go, and the switched-off slots and zone members in it go with it', () => {
    const removed = edited((w, boxes) => { boxes.splice(1, 1); });
    const plan = planWallEdit(before, removed, { bottles: [1, 37], marked: [25, 30, 38] });
    expect(Object.fromEntries(plan.move)).toEqual({ 1: 1, 37: 25, 38: 26 });
    expect([...plan.dropped]).toEqual([25, 30]);
  });

  test('a box sent without its id is a new box: the bottles of the old one have nowhere to go', () => {
    const anonymous = edited((w, boxes) => { delete boxes[2]._id; });
    expect(planWallEdit(before, anonymous, { bottles: [40] }).error).toMatch(/box C1 holds 1 bottle\(s\) and would be removed/);
    expect(planWallEdit(before, anonymous, { bottles: [1] }).move.get(1)).toBe(1);
  });

  test('every refusal is told at once', () => {
    const after = edited((w, boxes) => { boxes.splice(2, 1); boxes[0].perSection = 2; });
    const { error } = planWallEdit(before, after, { bottles: [3, 40, 41] });
    expect(error).toMatch(/box A1 would no longer have the place of 1 bottle/);
    expect(error).toMatch(/box C1 holds 2 bottle\(s\) and would be removed/);
  });
});
