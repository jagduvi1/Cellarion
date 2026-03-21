const { totalSlots, modularTotalSlots, getMaxPosition } = require('./rackGeometry');

describe('rackGeometry', () => {
  describe('totalSlots — grid', () => {
    it('returns rows × cols', () => {
      expect(totalSlots('grid', 4, 8)).toBe(32);
      expect(totalSlots('grid', 1, 1)).toBe(1);
      expect(totalSlots('grid', 20, 20)).toBe(400);
    });
  });

  describe('totalSlots — diamond', () => {
    it('radius 1 → 1 slot (centre only)', () => {
      expect(totalSlots('diamond', 1, 1)).toBe(1);
    });
    it('radius 2 → 5 slots', () => {
      expect(totalSlots('diamond', 2, 1)).toBe(5);
    });
    it('radius 3 → 13 slots', () => {
      expect(totalSlots('diamond', 3, 1)).toBe(13);
    });
    it('radius 4 → 25 slots', () => {
      expect(totalSlots('diamond', 4, 1)).toBe(25);
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

  describe('totalSlots — diamond with bottlesPerCell', () => {
    it('radius 2, bpc=2 → 10', () => {
      expect(totalSlots('diamond', 2, 1, { bottlesPerCell: 2 })).toBe(10);
    });
    it('radius 3, bpc=3 → 39', () => {
      expect(totalSlots('diamond', 3, 1, { bottlesPerCell: 3 })).toBe(39);
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
        { type: 'diamond', rows: 2, cols: 1 },   // 5
        { type: 'stack', rows: 6, cols: 1 },      // 6
      ];
      expect(modularTotalSlots(modules)).toBe(23);
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
