const { totalSlots, modularTotalSlots, getMaxPosition, validDoubleHeightRows, validateDoubleHeightRows } = require('./rackGeometry');

describe('rackGeometry', () => {
  // Request-side validator (moved here from routes/racks.js so the create
  // service and the update route share ONE implementation — MCP-audit H1).
  describe('validateDoubleHeightRows (request validation)', () => {
    it('accepts absent/null config and valid in-range rows', () => {
      expect(validateDoubleHeightRows(undefined, 'grid', 4, false)).toBeNull();
      expect(validateDoubleHeightRows({}, 'grid', 4, false)).toBeNull();
      expect(validateDoubleHeightRows({ doubleHeightRows: null }, 'grid', 4, false)).toBeNull();
      expect(validateDoubleHeightRows({ doubleHeightRows: [1, 4] }, 'grid', 4, false)).toBeNull();
      // effectiveType undefined defaults to grid
      expect(validateDoubleHeightRows({ doubleHeightRows: [2] }, undefined, 4, false)).toBeNull();
    });
    it('rejects non-grid, modular, non-array, and out-of-range entries', () => {
      expect(validateDoubleHeightRows({ doubleHeightRows: [1] }, 'hex', 4, false)).toMatch(/only supported on grid/);
      expect(validateDoubleHeightRows({ doubleHeightRows: [1] }, 'grid', 4, true)).toMatch(/only supported on grid/);
      expect(validateDoubleHeightRows({ doubleHeightRows: 2 }, 'grid', 4, false)).toMatch(/must be an array/);
      expect(validateDoubleHeightRows({ doubleHeightRows: [0] }, 'grid', 4, false)).toMatch(/between 1 and 4/);
      expect(validateDoubleHeightRows({ doubleHeightRows: [5] }, 'grid', 4, false)).toMatch(/between 1 and 4/);
      expect(validateDoubleHeightRows({ doubleHeightRows: [1.5] }, 'grid', 4, false)).toMatch(/between 1 and 4/);
    });
  });
  describe('totalSlots — grid', () => {
    it('returns rows × cols', () => {
      expect(totalSlots('grid', 4, 8)).toBe(32);
      expect(totalSlots('grid', 1, 1)).toBe(1);
      expect(totalSlots('grid', 20, 20)).toBe(400);
    });
  });

  describe('totalSlots — grid with double-height rows', () => {
    // Capacity = rows*cols + validDoubleRows.length * (cols - 1); top-layer
    // positions are appended after rows*cols (see numbering contract in
    // rackGeometry.js).
    it('adds cols-1 top slots per double row (4x6, row 2 → 24 + 5 = 29)', () => {
      expect(totalSlots('grid', 4, 6, { doubleHeightRows: [2] })).toBe(29);
    });
    it('multiple double rows: 4x6 with rows [1,3] → 24 + 2×5 = 34', () => {
      expect(totalSlots('grid', 4, 6, { doubleHeightRows: [1, 3] })).toBe(34);
    });
    it('filters out-of-range and duplicate entries', () => {
      expect(totalSlots('grid', 4, 6, { doubleHeightRows: [0, 2, 2, 5, 99, -1] })).toBe(29);
    });
    it('ignores non-integer entries', () => {
      expect(totalSlots('grid', 4, 6, { doubleHeightRows: [1.5, '2', null] })).toBe(24);
    });
    it('cols = 1 contributes nothing (no gap to rest a bottle in)', () => {
      expect(totalSlots('grid', 4, 1, { doubleHeightRows: [2] })).toBe(4);
    });
    it('empty or missing doubleHeightRows leaves capacity unchanged', () => {
      expect(totalSlots('grid', 4, 6, { doubleHeightRows: [] })).toBe(24);
      expect(totalSlots('grid', 4, 6, {})).toBe(24);
    });
  });

  describe('validDoubleHeightRows', () => {
    it('returns ascending unique valid rows', () => {
      expect(validDoubleHeightRows(4, 6, [3, 1, 3])).toEqual([1, 3]);
    });
    it('drops entries outside [1, rows]', () => {
      expect(validDoubleHeightRows(4, 6, [0, 4, 5])).toEqual([4]);
    });
    it('returns [] for non-array input or cols <= 1', () => {
      expect(validDoubleHeightRows(4, 6, undefined)).toEqual([]);
      expect(validDoubleHeightRows(4, 6, 'nope')).toEqual([]);
      expect(validDoubleHeightRows(4, 1, [2])).toEqual([]);
    });
  });

  describe('totalSlots — x-rack', () => {
    it('default bottlesPerSection (10) → 40 slots', () => {
      expect(totalSlots('x-rack', 1, 1)).toBe(40);
    });
    it('bottlesPerSection 6 → 24 slots', () => {
      expect(totalSlots('x-rack', 1, 1, { bottlesPerSection: 6 })).toBe(24);
    });
    it('bottlesPerSection 1 → 4 slots', () => {
      expect(totalSlots('x-rack', 1, 1, { bottlesPerSection: 1 })).toBe(4);
    });
    it('bottlesPerSection 15 → 60 slots', () => {
      expect(totalSlots('x-rack', 1, 1, { bottlesPerSection: 15 })).toBe(60);
    });
  });

  describe('totalSlots — hex', () => {
    it('3 rows, 4 cols → 4 + 3 + 4 = 11', () => {
      expect(totalSlots('hex', 3, 4)).toBe(11);
    });
    it('1 row, 5 cols → 5', () => {
      expect(totalSlots('hex', 1, 5)).toBe(5);
    });
    it('4 rows, 3 cols → 3 + 2 + 3 + 2 = 10', () => {
      expect(totalSlots('hex', 4, 3)).toBe(10);
    });
    it('2 rows, 1 col → 1 + 1 = 2 (odd row min is 1)', () => {
      expect(totalSlots('hex', 2, 1)).toBe(2);
    });
    // Security audit 2026-09-02 (D14-1): the hex count was a `rows`-iteration
    // loop and the rack update route ran it on unvalidated input — one
    // request with rows "1e308" stalled the backend. Closed form now; these
    // pin it to the loop it replaced across the whole legal range.
    it('closed form matches the row-by-row count for every legal size', () => {
      const byLoop = (rows, cols) => { let t = 0; for (let r = 0; r < rows; r++) t += (r % 2 === 0) ? cols : Math.max(1, cols - 1); return t; };
      for (let rows = 1; rows <= 20; rows++) {
        for (let cols = 1; cols <= 20; cols++) {
          expect(totalSlots('hex', rows, cols)).toBe(byLoop(rows, cols));
        }
      }
    });
    it('an absurd or non-finite dimension returns at once instead of looping', () => {
      const t0 = Date.now();
      expect(typeof totalSlots('hex', 1e308, 5)).toBe('number'); // overflows to Infinity — fine, it RETURNS
      expect(totalSlots('hex', Infinity, 5)).toBe(0);
      expect(totalSlots('grid', 4, NaN)).toBe(0);
      expect(getMaxPosition({ isModular: true, modules: [{ type: 'hex', rows: 1e15, cols: 2 }] })).toBe(1.5e15);
      expect(Date.now() - t0).toBeLessThan(200);
    });
    it('hexEqualRows: every row full width → rows × cols', () => {
      expect(totalSlots('hex', 4, 4, { hexEqualRows: true })).toBe(16);
      expect(totalSlots('hex', 3, 4, { hexEqualRows: true })).toBe(12);
      // The Liebherr GrandCru top/bottom shelf from the feature request: 4-4-4-4.
      expect(totalSlots('hex', 4, 4)).toBe(14); // classic alternation, unchanged
    });
    it('hexEqualRows composes with hexFlip without changing the total', () => {
      expect(totalSlots('hex', 4, 4, { hexEqualRows: true, hexFlip: true })).toBe(16);
    });
    it('hexEqualRows false/absent keeps the classic alternating total', () => {
      expect(totalSlots('hex', 4, 3, { hexEqualRows: false })).toBe(10);
      expect(totalSlots('hex', 4, 3, { hexFlip: true })).toBe(10);
    });
  });

  describe('totalSlots — triangle', () => {
    it('base 1 → 1', () => {
      expect(totalSlots('triangle', 1, 1)).toBe(1);
    });
    it('base 4 → 10', () => {
      expect(totalSlots('triangle', 1, 4)).toBe(10);
    });
    it('base 5 → 15', () => {
      expect(totalSlots('triangle', 1, 5)).toBe(15);
    });
    it('base 8 → 36', () => {
      expect(totalSlots('triangle', 1, 8)).toBe(36);
    });
  });

  describe('totalSlots — stack', () => {
    it('returns rows', () => {
      expect(totalSlots('stack', 6, 1)).toBe(6);
      expect(totalSlots('stack', 1, 1)).toBe(1);
      expect(totalSlots('stack', 20, 1)).toBe(20);
    });
  });

  describe('totalSlots — cube', () => {
    it('2×2 outer, default 2×2 modules → 16', () => {
      expect(totalSlots('cube', 2, 2)).toBe(16);
    });
    it('3×2 outer, 3×3 modules → 54', () => {
      expect(totalSlots('cube', 3, 2, { moduleRows: 3, moduleCols: 3 })).toBe(54);
    });
    it('1×1 outer, 2×2 module → 4', () => {
      expect(totalSlots('cube', 1, 1, { moduleRows: 2, moduleCols: 2 })).toBe(4);
    });
  });

  describe('totalSlots — shelf', () => {
    it('3 rows, 2 cols → 6 (bpc=1 default)', () => {
      expect(totalSlots('shelf', 3, 2)).toBe(6);
    });
    it('2 rows, 3 cols with bpc=4 → 24', () => {
      expect(totalSlots('shelf', 2, 3, { bottlesPerCell: 4 })).toBe(24);
    });
    it('1×1 with bpc=6 → 6', () => {
      expect(totalSlots('shelf', 1, 1, { bottlesPerCell: 6 })).toBe(6);
    });
  });

  describe('totalSlots — unknown type falls back to grid', () => {
    it('returns rows × cols', () => {
      expect(totalSlots('unknown', 3, 5)).toBe(15);
    });
  });

  describe('modularTotalSlots', () => {
    it('returns 0 for empty array', () => {
      expect(modularTotalSlots([])).toBe(0);
    });
    it('returns 0 for null/undefined', () => {
      expect(modularTotalSlots(null)).toBe(0);
      expect(modularTotalSlots(undefined)).toBe(0);
    });
    it('sums a single grid module', () => {
      expect(modularTotalSlots([{ type: 'grid', rows: 4, cols: 8 }])).toBe(32);
    });
    it('sums mixed module types', () => {
      const modules = [
        { type: 'grid', rows: 3, cols: 4 },     // 12
        { type: 'hex', rows: 3, cols: 4 },       // 11
        { type: 'stack', rows: 6, cols: 1 },      // 6
      ];
      expect(modularTotalSlots(modules)).toBe(29);
    });
    it('sums triangle + hex', () => {
      const modules = [
        { type: 'triangle', rows: 1, cols: 4 },  // 10
        { type: 'hex', rows: 3, cols: 4 },        // 11
      ];
      expect(modularTotalSlots(modules)).toBe(21);
    });
  });

  describe('getMaxPosition', () => {
    it('reads type from rack object', () => {
      expect(getMaxPosition({ type: 'triangle', rows: 1, cols: 5 })).toBe(15);
    });
    it('defaults to grid when type is missing', () => {
      expect(getMaxPosition({ rows: 4, cols: 8 })).toBe(32);
    });
    it('passes typeConfig for cube', () => {
      expect(getMaxPosition({ type: 'cube', rows: 2, cols: 2, typeConfig: { moduleRows: 3, moduleCols: 3 } })).toBe(36);
    });
    it('x-rack uses bottlesPerSection', () => {
      expect(getMaxPosition({ type: 'x-rack', rows: 1, cols: 1, typeConfig: { bottlesPerSection: 6 } })).toBe(24);
    });
    it('grid includes appended double-height top-layer positions', () => {
      expect(getMaxPosition({ type: 'grid', rows: 4, cols: 6, typeConfig: { doubleHeightRows: [2] } })).toBe(29);
    });
    it('uses modules when isModular is true', () => {
      const rack = {
        isModular: true,
        modules: [
          { type: 'grid', rows: 3, cols: 4 },
          { type: 'stack', rows: 5, cols: 1 },
        ],
        type: 'grid', rows: 4, cols: 8, // should be ignored
      };
      expect(getMaxPosition(rack)).toBe(17); // 12 + 5
    });
    it('falls back to simple when isModular is false', () => {
      const rack = { isModular: false, modules: [], type: 'grid', rows: 4, cols: 8 };
      expect(getMaxPosition(rack)).toBe(32);
    });
    it('falls back to simple when modules is empty', () => {
      const rack = { isModular: true, modules: [], type: 'grid', rows: 3, cols: 3 };
      expect(getMaxPosition(rack)).toBe(9);
    });
  });
});

// ── Cabinet (wine fridge) ───────────────────────────────────────────────────
// Position contract: shelves top to bottom; inside a bay row 1 rests on the
// plank; position = cols × Σ shelfRows[k<i] + (row − 1) × cols + slot.
const { cabinetShelfRows, cabinetPosition, validateCabinetConfig, cabinetRowWidth, cabinetBayCapacity, cabinetRows, cabinetBays } = require('./rackGeometry');

describe('cabinet rack geometry', () => {
  test('capacity is cols × Σ shelfRows; missing entries count as 1', () => {
    expect(totalSlots('cabinet', 5, 7, { shelfRows: [4, 4, 4, 4, 4] })).toBe(140);
    expect(totalSlots('cabinet', 3, 6, { shelfRows: [1, 2] })).toBe(6 + 12 + 6);
    expect(totalSlots('cabinet', 2, 5, {})).toBe(10);
    // entries are clamped to 1..12 on read; extras beyond rows are ignored
    expect(totalSlots('cabinet', 1, 5, { shelfRows: [40, 9, 9] })).toBe(60);
  });

  test('cabinetShelfRows fits the list to the shelf count', () => {
    expect(cabinetShelfRows(4, { shelfRows: [2, 3] })).toEqual([2, 3, 1, 1]);
    expect(cabinetShelfRows(2, { shelfRows: [0, -3] })).toEqual([1, 1]);
    expect(cabinetShelfRows(0, { shelfRows: [2] })).toEqual([]);
  });

  test('cabinetPosition follows the contract: bay base, then rows from the plank, slots left to right', () => {
    const shape = { cols: 6, shelfRows: [1, 3, 2] }; // 6 + 18 + 12 = 36
    expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 1, slot: 1 })).toBe(1);
    expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 1, slot: 6 })).toBe(6);
    expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 1, slot: 1 })).toBe(7);
    expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 3, slot: 6 })).toBe(24);
    expect(cabinetPosition({ ...shape, shelfIndex: 2, row: 2, slot: 4 })).toBe(24 + 6 + 4);
    expect(cabinetPosition({ ...shape, shelfIndex: 2, row: 2, slot: 6 })).toBe(totalSlots('cabinet', 3, 6, shape));
    // out of the bay's rows / the shelf width / the shelf list → null, never a neighbour
    expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 2, slot: 1 })).toBeNull();
    expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 1, slot: 7 })).toBeNull();
    expect(cabinetPosition({ ...shape, shelfIndex: 3, row: 1, slot: 1 })).toBeNull();
  });

  test('validateCabinetConfig: shelfRows must match rows, 1..12 whole numbers; cabinet only', () => {
    expect(validateCabinetConfig({ shelfRows: [2, 2, 2], twoDeep: true }, 'cabinet', 3, false)).toBeNull();
    expect(validateCabinetConfig({}, 'cabinet', 3, false)).toBeNull(); // nothing to validate
    expect(validateCabinetConfig({ shelfRows: [2, 2] }, 'cabinet', 3, false)).toMatch(/one entry per shelf/);
    expect(validateCabinetConfig({ shelfRows: [2, 0, 2] }, 'cabinet', 3, false)).toMatch(/between 1 and 12/);
    expect(validateCabinetConfig({ shelfRows: [2, 13, 2] }, 'cabinet', 3, false)).toMatch(/between 1 and 12/);
    expect(validateCabinetConfig({ shelfRows: [2, 2.5, 2] }, 'cabinet', 3, false)).toMatch(/between 1 and 12/);
    expect(validateCabinetConfig({ twoDeep: 'yes', shelfRows: [1] }, 'cabinet', 1, false)).toMatch(/boolean/);
    expect(validateCabinetConfig({ twoDeep: true }, 'cabinet', 1, false)).toMatch(/required/);
    expect(validateCabinetConfig({ shelfRows: [1, 1] }, 'grid', 2, false)).toMatch(/cabinet racks only/);
    expect(validateCabinetConfig({ shelfRows: [1, 1] }, 'cabinet', 2, true)).toMatch(/cabinet racks only/);
    expect(validateCabinetConfig(null, 'cabinet', 2, false)).toBeNull();
  });

  test('stagger is a boolean, cabinet-only, and never changes capacity', () => {
    expect(validateCabinetConfig({ shelfRows: [2, 2], stagger: true }, 'cabinet', 2, false)).toBeNull();
    expect(validateCabinetConfig({ shelfRows: [2, 2], stagger: false }, 'cabinet', 2, false)).toBeNull();
    expect(validateCabinetConfig({ shelfRows: [2, 2], stagger: 'yes' }, 'cabinet', 2, false)).toMatch(/stagger must be a boolean/);
    // stagger alone still needs the shelf list, and never rides on another type
    expect(validateCabinetConfig({ stagger: true }, 'cabinet', 2, false)).toMatch(/required/);
    expect(validateCabinetConfig({ stagger: true }, 'grid', 2, false)).toMatch(/cabinet racks only/);
    // Drawing only: capacity is the same either way.
    expect(totalSlots('cabinet', 3, 6, { shelfRows: [1, 3, 2], stagger: true }))
      .toBe(totalSlots('cabinet', 3, 6, { shelfRows: [1, 3, 2], stagger: false }));
  });

  test('getMaxPosition reads a cabinet document', () => {
    expect(getMaxPosition({ type: 'cabinet', rows: 2, cols: 4, typeConfig: { shelfRows: [1, 5] } })).toBe(24);
  });

  // ── Alternating rows (support ticket 2026-09-15: Liebherr GrandCru 5001) ──
  // The rows of a bay are cols / cols−1 wide in turn: 6 in front of 5, then
  // 5 in front of 6. Unlike twoDeep and stagger this changes capacity and
  // the numbering, so it is pinned here row by row.
  describe('alternate', () => {
    test('row widths follow the honeycomb: two deep 6/5, 5/6, 6/5…; single deep 6, 5, 6…', () => {
      const deep = { twoDeep: true, alternate: true };
      expect([1, 2, 3, 4, 5, 6, 7, 8].map((r) => cabinetRowWidth(r, 6, deep))).toEqual([6, 5, 5, 6, 6, 5, 5, 6]);
      const single = { twoDeep: false, alternate: true };
      expect([1, 2, 3, 4, 5].map((r) => cabinetRowWidth(r, 6, single))).toEqual([6, 5, 6, 5, 6]);
      // Off (the default): every row is cols wide, whatever twoDeep says.
      expect([1, 2, 3, 4].map((r) => cabinetRowWidth(r, 6, { twoDeep: true, alternate: false }))).toEqual([6, 6, 6, 6]);
      expect([1, 2, 3].map((r) => cabinetRowWidth(r, 6))).toEqual([6, 6, 6]);
      // A one-wide cabinet has nothing to alternate — never a 0-wide row.
      expect([1, 2, 3, 4].map((r) => cabinetRowWidth(r, 1, deep))).toEqual([1, 1, 1, 1]);
    });

    test('capacity is the sum of the real row widths: a GrandCru shelf of 6/5, 5/6, 6/5, 5/6 holds 44', () => {
      expect(cabinetBayCapacity(8, 6, { twoDeep: true, alternate: true })).toBe(44);
      expect(cabinetBayCapacity(7, 6, { twoDeep: true, alternate: true })).toBe(38);
      expect(cabinetBayCapacity(7, 6, { twoDeep: true, alternate: false })).toBe(42);
      // The 5001 preset: three honeycomb shelves of 44 between two of 33.
      expect(totalSlots('cabinet', 5, 6, { shelfRows: [6, 8, 8, 8, 6], twoDeep: true, alternate: true })).toBe(198);
      expect(totalSlots('cabinet', 1, 6, { shelfRows: [4], twoDeep: false, alternate: true })).toBe(6 + 5 + 6 + 5);
      // Not set → the plain cols × Σ shelfRows of every existing cabinet.
      expect(totalSlots('cabinet', 5, 6, { shelfRows: [6, 8, 8, 8, 6], twoDeep: true })).toBe(216);
      expect(getMaxPosition({ type: 'cabinet', rows: 2, cols: 6, typeConfig: { shelfRows: [2, 3], alternate: true } })).toBe(11 + 16);
    });

    test('cabinetPosition sums the earlier rows\' own widths and refuses a slot past a narrow row', () => {
      const shape = { cols: 6, shelfRows: [2, 3], twoDeep: true, alternate: true }; // (6+5) + (6+5+5) = 27
      expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 1, slot: 6 })).toBe(6);
      expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 2, slot: 1 })).toBe(7);
      expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 2, slot: 5 })).toBe(11);
      expect(cabinetPosition({ ...shape, shelfIndex: 0, row: 2, slot: 6 })).toBeNull(); // the back row holds 5
      expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 1, slot: 1 })).toBe(12);
      expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 3, slot: 5 })).toBe(27);
      expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 3, slot: 6 })).toBeNull();
      expect(cabinetPosition({ ...shape, shelfIndex: 1, row: 3, slot: 5 })).toBe(totalSlots('cabinet', 2, 6, shape));
      // Single deep: level 2 is the narrow one.
      const single = { cols: 4, shelfRows: [3], twoDeep: false, alternate: true }; // 4 + 3 + 4
      expect(cabinetPosition({ ...single, shelfIndex: 0, row: 2, slot: 3 })).toBe(7);
      expect(cabinetPosition({ ...single, shelfIndex: 0, row: 2, slot: 4 })).toBeNull();
      expect(cabinetPosition({ ...single, shelfIndex: 0, row: 3, slot: 4 })).toBe(11);
    });

    test('cabinetRows walks every bottle row in position order with its start and width', () => {
      expect(cabinetRows(2, 6, { shelfRows: [1, 3], alternate: true })).toEqual([
        { shelfIndex: 0, row: 1, start: 0, width: 6 },
        { shelfIndex: 1, row: 1, start: 6, width: 6 },
        { shelfIndex: 1, row: 2, start: 12, width: 5 },
        { shelfIndex: 1, row: 3, start: 17, width: 5 },
      ]);
      expect(cabinetRows(2, 4, { shelfRows: [1, 2] }).map((r) => [r.start, r.width])).toEqual([[0, 4], [4, 4], [8, 4]]);
    });

    // Support ticket 2026-08-31: the 5001's loading diagram is three 6-wide
    // honeycomb shelves between two 4-wide staggered ones — per-shelf width
    // and pattern, one cabinet.
    test('per-shelf width and pattern: the GrandCru 5001 loading diagram is one cabinet of 196', () => {
      const tc = { shelfRows: [8, 8, 8, 8, 8], shelfCols: [4, 6, 6, 6, 4], shelfAlternate: [false, true, true, true, false], twoDeep: true };
      expect(cabinetBays(5, 6, tc)).toEqual([
        { rows: 8, cols: 4, alternate: false }, { rows: 8, cols: 6, alternate: true }, { rows: 8, cols: 6, alternate: true },
        { rows: 8, cols: 6, alternate: true }, { rows: 8, cols: 4, alternate: false },
      ]);
      expect(totalSlots('cabinet', 5, 6, tc)).toBe(2 * 32 + 3 * 44);
      // Top bay: 8 rows of 4 → 1..32; the honeycomb bay below starts at 33.
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 0, row: 8, slot: 4 })).toBe(32);
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 0, row: 1, slot: 5 })).toBeNull();
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 1, row: 1, slot: 1 })).toBe(33);
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 1, row: 2, slot: 5 })).toBe(33 + 6 + 4);
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 1, row: 2, slot: 6 })).toBeNull();
      expect(cabinetPosition({ cols: 6, ...tc, shelfIndex: 4, row: 8, slot: 4 })).toBe(196);
      expect(cabinetRows(5, 6, tc).map((r) => r.width).slice(6, 12)).toEqual([4, 4, 6, 5, 5, 6]);
      // Missing entries mean the cabinet's own width / pattern; a width past
      // the cabinet is clamped on read.
      expect(cabinetBays(3, 6, { shelfRows: [1, 1, 1], shelfCols: [4], shelfAlternate: [true], alternate: false }))
        .toEqual([{ rows: 1, cols: 4, alternate: true }, { rows: 1, cols: 6, alternate: false }, { rows: 1, cols: 6, alternate: false }]);
      expect(cabinetBays(1, 6, { shelfRows: [1], shelfCols: [9] })[0].cols).toBe(6);
      expect(totalSlots('cabinet', 2, 6, { shelfRows: [2, 2], shelfCols: [3, 6] })).toBe(6 + 12);
    });

    test('validateCabinetConfig: shelfCols 1..cols and shelfAlternate booleans, one entry per shelf', () => {
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfCols: [4, 6], shelfAlternate: [false, true] }, 'cabinet', 2, false, 6)).toBeNull();
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfCols: [4] }, 'cabinet', 2, false, 6)).toMatch(/shelfCols must list one entry per shelf/);
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfCols: [4, 7] }, 'cabinet', 2, false, 6)).toMatch(/between 1 and the cabinet width \(6\)/);
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfCols: [0, 6] }, 'cabinet', 2, false, 6)).toMatch(/cabinet width/);
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfCols: [2.5, 6] }, 'cabinet', 2, false, 6)).toMatch(/cabinet width/);
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfAlternate: [true] }, 'cabinet', 2, false, 6)).toMatch(/shelfAlternate must list one entry per shelf/);
      expect(validateCabinetConfig({ shelfRows: [2, 2], shelfAlternate: [true, 'no'] }, 'cabinet', 2, false, 6)).toMatch(/shelfAlternate entry must be a boolean/);
      expect(validateCabinetConfig({ shelfCols: [4, 6] }, 'cabinet', 2, false, 6)).toMatch(/shelfRows is required/);
      expect(validateCabinetConfig({ shelfCols: [4, 6] }, 'grid', 2, false, 6)).toMatch(/cabinet racks only/);
      // Without a known width the schema's 20 bounds it.
      expect(validateCabinetConfig({ shelfRows: [1], shelfCols: [20] }, 'cabinet', 1, false)).toBeNull();
      expect(validateCabinetConfig({ shelfRows: [1], shelfCols: [21] }, 'cabinet', 1, false)).toMatch(/cabinet width/);
    });

    test('validateCabinetConfig: alternate is a boolean and cabinet-only', () => {
      expect(validateCabinetConfig({ shelfRows: [2, 2], alternate: true }, 'cabinet', 2, false)).toBeNull();
      expect(validateCabinetConfig({ shelfRows: [2, 2], alternate: false }, 'cabinet', 2, false)).toBeNull();
      expect(validateCabinetConfig({ shelfRows: [2, 2], alternate: 'yes' }, 'cabinet', 2, false)).toMatch(/alternate must be a boolean/);
      expect(validateCabinetConfig({ alternate: true }, 'cabinet', 2, false)).toMatch(/required/);
      expect(validateCabinetConfig({ alternate: true }, 'grid', 2, false)).toMatch(/cabinet racks only/);
    });
  });
});
