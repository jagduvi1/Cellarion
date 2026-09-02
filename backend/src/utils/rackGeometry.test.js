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
