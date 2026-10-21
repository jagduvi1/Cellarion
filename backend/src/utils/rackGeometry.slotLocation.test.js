/**
 * slotLocation — a slot position in the words someone at the rack uses.
 *
 * WHY THIS TEST EXISTS:
 * GET /api/inventory and the MCP get_bottle placement tell a person "shelf 2,
 * row 1, slot 3" instead of "position 14". A wrong reverse mapping sends them
 * to the wrong bottle, so every cabinet case is pinned as an exact round trip
 * through cabinetPosition (the forward contract the importers and renderers
 * share), and grids against the cellar export's rackRow / rackCol formula.
 */
const { slotLocation, cabinetPosition, cabinetShelfRows, getMaxPosition } = require('./rackGeometry');

const NONE = { shelf: null, row: null, col: null };

// Every position of the cabinet maps to a cell that maps back to it.
function expectRoundTrip(rack) {
  const tc = rack.typeConfig || {};
  const max = getMaxPosition(rack);
  expect(max).toBeGreaterThan(0);
  for (let p = 1; p <= max; p++) {
    const loc = slotLocation(rack, p);
    expect(loc.shelf).toBeGreaterThanOrEqual(1);
    const back = cabinetPosition({
      shelfIndex: loc.shelf - 1, row: loc.row, slot: loc.col, cols: rack.cols,
      shelfRows: tc.shelfRows || cabinetShelfRows(rack.rows, tc), twoDeep: tc.twoDeep, alternate: tc.alternate,
      shelfCols: tc.shelfCols, shelfAlternate: tc.shelfAlternate, shelfSideways: tc.shelfSideways,
    });
    expect(back).toBe(p);
  }
  expect(slotLocation(rack, max + 1)).toEqual(NONE);
}

describe('slotLocation — cabinet', () => {
  test('shelf from the top, row from the plank, slot left to right', () => {
    // A sliding shelf, a two-row stacking bay, a sliding shelf; 6 across.
    const rack = { type: 'cabinet', rows: 3, cols: 6, typeConfig: { shelfRows: [1, 2, 1] } };
    expect(slotLocation(rack, 1)).toEqual({ shelf: 1, row: 1, col: 1 });
    expect(slotLocation(rack, 6)).toEqual({ shelf: 1, row: 1, col: 6 });
    expect(slotLocation(rack, 7)).toEqual({ shelf: 2, row: 1, col: 1 });
    expect(slotLocation(rack, 14)).toEqual({ shelf: 2, row: 2, col: 2 });
    expect(slotLocation(rack, 24)).toEqual({ shelf: 3, row: 1, col: 6 });
    expectRoundTrip(rack);
  });

  test('two deep and alternating (a GrandCru honeycomb): 6 in front of 5', () => {
    const rack = { type: 'cabinet', rows: 2, cols: 6, typeConfig: { shelfRows: [2, 2], twoDeep: true, alternate: true } };
    // Shelf 1: front row 1..6, back row (in the gaps) 7..11; shelf 2 the same.
    expect(slotLocation(rack, 6)).toEqual({ shelf: 1, row: 1, col: 6 });
    expect(slotLocation(rack, 7)).toEqual({ shelf: 1, row: 2, col: 1 });
    expect(slotLocation(rack, 11)).toEqual({ shelf: 1, row: 2, col: 5 });
    expect(slotLocation(rack, 12)).toEqual({ shelf: 2, row: 1, col: 1 });
    expect(slotLocation(rack, 22)).toEqual({ shelf: 2, row: 2, col: 5 });
    expect(slotLocation(rack, 23)).toEqual(NONE);
    expectRoundTrip(rack);
  });

  test('alternating stacked levels two deep: 6/5 then 5/6', () => {
    const rack = { type: 'cabinet', rows: 1, cols: 6, typeConfig: { shelfRows: [4], twoDeep: true, alternate: true } };
    // Rows: 6 (front L1), 5 (back L1), 5 (front L2), 6 (back L2).
    expect(slotLocation(rack, 12)).toEqual({ shelf: 1, row: 3, col: 1 });
    expect(slotLocation(rack, 16)).toEqual({ shelf: 1, row: 3, col: 5 });
    expect(slotLocation(rack, 17)).toEqual({ shelf: 1, row: 4, col: 1 });
    expect(slotLocation(rack, 22)).toEqual({ shelf: 1, row: 4, col: 6 });
    expectRoundTrip(rack);
  });

  test('narrower and per-shelf alternating shelves (GrandCru 5001)', () => {
    const rack = {
      type: 'cabinet', rows: 3, cols: 6,
      typeConfig: { shelfRows: [1, 2, 1], shelfCols: [4, 6, 4], shelfAlternate: [false, true, false], twoDeep: true },
    };
    expect(slotLocation(rack, 4)).toEqual({ shelf: 1, row: 1, col: 4 });
    expect(slotLocation(rack, 5)).toEqual({ shelf: 2, row: 1, col: 1 });
    expectRoundTrip(rack);
  });

  test('one deep with a bottle across the front: levels above hold one fewer', () => {
    const rack = { type: 'cabinet', rows: 1, cols: 5, typeConfig: { shelfRows: [3], twoDeep: false, shelfSideways: ['front'] } };
    // 5, then 4, then 4.
    expect(slotLocation(rack, 5)).toEqual({ shelf: 1, row: 1, col: 5 });
    expect(slotLocation(rack, 6)).toEqual({ shelf: 1, row: 2, col: 1 });
    expect(slotLocation(rack, 13)).toEqual({ shelf: 1, row: 3, col: 4 });
    expectRoundTrip(rack);
  });

  test('a cabinet whose shelf config went missing still answers (one row per shelf)', () => {
    const rack = { type: 'cabinet', rows: 2, cols: 3 };
    expect(slotLocation(rack, 4)).toEqual({ shelf: 2, row: 1, col: 1 });
    expectRoundTrip(rack);
  });
});

describe('slotLocation — grid', () => {
  // The cellar export's human-readable placement (services/cellarExport).
  const exportRowCol = (pos, cols) => ({ row: Math.ceil(pos / cols), col: ((pos - 1) % cols) + 1 });

  test('row-major from the top left, as the export and the renderer number it', () => {
    const rack = { type: 'grid', rows: 4, cols: 6 };
    for (let p = 1; p <= 24; p++) {
      expect(slotLocation(rack, p)).toEqual({ shelf: null, ...exportRowCol(p, 6) });
    }
    expect(slotLocation(rack, 7)).toEqual({ shelf: null, row: 2, col: 1 });
    expect(slotLocation(rack, 25)).toEqual(NONE);
  });

  test('a rack without a type is a grid', () => {
    expect(slotLocation({ rows: 2, cols: 3 }, 5)).toEqual({ shelf: null, row: 2, col: 2 });
  });

  test('double-height rows: top-layer positions follow rows × cols, row by row', () => {
    // 4×6 with row 2 double: base 1..24 unchanged, row 2's top layer = 25..29.
    const rack = { type: 'grid', rows: 4, cols: 6, typeConfig: { doubleHeightRows: [2] } };
    expect(slotLocation(rack, 24)).toEqual({ shelf: null, row: 4, col: 6 });
    expect(slotLocation(rack, 25)).toEqual({ shelf: null, row: 2, col: 1 });
    expect(slotLocation(rack, 29)).toEqual({ shelf: null, row: 2, col: 5 });
    expect(slotLocation(rack, 30)).toEqual(NONE);

    const two = { type: 'grid', rows: 3, cols: 4, typeConfig: { doubleHeightRows: [3, 1] } };
    expect(slotLocation(two, 13)).toEqual({ shelf: null, row: 1, col: 1 });
    expect(slotLocation(two, 15)).toEqual({ shelf: null, row: 1, col: 3 });
    expect(slotLocation(two, 16)).toEqual({ shelf: null, row: 3, col: 1 });
    expect(slotLocation(two, 18)).toEqual({ shelf: null, row: 3, col: 3 });
    expect(slotLocation(two, 19)).toEqual(NONE);
  });
});

describe('slotLocation — everything else is nulls', () => {
  test.each(['hex', 'x-rack', 'triangle', 'stack', 'cube', 'shelf'])('%s', (type) => {
    expect(slotLocation({ type, rows: 3, cols: 3 }, 2)).toEqual(NONE);
  });

  test('a modular rack (positions span its modules)', () => {
    const rack = { isModular: true, modules: [{ type: 'grid', rows: 2, cols: 2 }], type: 'grid', rows: 2, cols: 2 };
    expect(slotLocation(rack, 1)).toEqual(NONE);
  });

  test.each([[0], [-1], [1.5], ['3'], [null], [undefined], [NaN]])('position %p', (pos) => {
    expect(slotLocation({ type: 'grid', rows: 2, cols: 2 }, pos)).toEqual(NONE);
  });

  test('no rack, or a rack without usable dimensions', () => {
    expect(slotLocation(null, 1)).toEqual(NONE);
    expect(slotLocation({ type: 'grid', rows: 0, cols: 4 }, 1)).toEqual(NONE);
    expect(slotLocation({ type: 'grid', rows: 2 }, 1)).toEqual(NONE);
  });
});
