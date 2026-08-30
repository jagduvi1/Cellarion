import {
  computeLayout, computeModularLayout, getModularTotalSlots, getTotalSlots,
  SLOT_RADIUS, validDoubleHeightRows, DOUBLE_ROW_HEADROOM,
} from './rackLayouts';

describe('computeLayout', () => {
  describe('grid', () => {
    it('returns rows × cols slots', () => {
      const layout = computeLayout('grid', 4, 8);
      expect(layout.totalSlots).toBe(32);
      expect(layout.slots).toHaveLength(32);
    });

    it('1×1 grid has one slot', () => {
      const layout = computeLayout('grid', 1, 1);
      expect(layout.totalSlots).toBe(1);
    });

    it('positions are contiguous 1..N', () => {
      const layout = computeLayout('grid', 3, 4);
      const positions = layout.slots.map(s => s.position);
      expect(positions).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
    });
  });

  describe('grid — double-height rows', () => {
    // POSITION NUMBERING CONTRACT: base grid keeps positions 1..rows*cols
    // row-major exactly as a plain grid; top-layer positions are APPENDED
    // after rows*cols in ascending row order, cols-1 per double row.
    const CELL = 48; // SLOT_R*2 + SLOT_GAP

    it('appends cols-1 top slots per double row (4x6, row 2 → 29)', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      expect(layout.totalSlots).toBe(29);
      expect(layout.slots.map(s => s.position))
        .toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    });

    it('base positions 1..rows*cols keep plain-grid order and x coordinates', () => {
      const plain = computeLayout('grid', 4, 6);
      const dbl = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      for (let i = 0; i < 24; i++) {
        expect(dbl.slots[i].position).toBe(plain.slots[i].position);
        expect(dbl.slots[i].cx).toBe(plain.slots[i].cx);
      }
    });

    it('top-layer slots sit staggered between and above their base row', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      const baseRow2 = layout.slots.filter(s => s.position >= 7 && s.position <= 12);
      const tops = layout.slots.filter(s => s.isTop);
      expect(tops.map(s => s.position)).toEqual([25, 26, 27, 28, 29]);
      tops.forEach((s, i) => {
        expect(s.cx).toBeCloseTo((baseRow2[i].cx + baseRow2[i + 1].cx) / 2);
        expect(s.cy).toBeCloseTo(baseRow2[i].cy - CELL * DOUBLE_ROW_HEADROOM);
      });
    });

    it('grows taller per double row; rows below the double row shift down', () => {
      const plain = computeLayout('grid', 4, 6);
      const dbl = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      const extra = CELL * DOUBLE_ROW_HEADROOM;
      expect(dbl.viewBox.height).toBeCloseTo(plain.viewBox.height + extra);
      expect(dbl.slots[0].cy).toBe(plain.slots[0].cy);            // row 1 unchanged
      expect(dbl.slots[6].cy).toBeCloseTo(plain.slots[6].cy + extra);   // row 2 shifted
      expect(dbl.slots[23].cy).toBeCloseTo(plain.slots[23].cy + extra); // row 4 shifted
    });

    it('emits explicit shelfYs so planks skip the top layers', () => {
      const layout = computeLayout('grid', 4, 6, { doubleHeightRows: [2] });
      expect(layout.shelfYs).toHaveLength(3); // rows-1 planks, top layer not counted
    });

    it('filters invalid rows; cols = 1 contributes nothing', () => {
      expect(computeLayout('grid', 4, 6, { doubleHeightRows: [0, 99] }).totalSlots).toBe(24);
      expect(computeLayout('grid', 4, 1, { doubleHeightRows: [2] }).totalSlots).toBe(4);
    });

    it('getTotalSlots matches computeLayout and the backend formula', () => {
      const tc = { doubleHeightRows: [1, 3] };
      expect(getTotalSlots('grid', 4, 6, tc)).toBe(4 * 6 + 2 * (6 - 1));
      expect(getTotalSlots('grid', 4, 6, tc)).toBe(computeLayout('grid', 4, 6, tc).totalSlots);
    });

    it('validDoubleHeightRows dedupes, sorts and filters', () => {
      expect(validDoubleHeightRows(4, 6, [3, 1, 3, 0, 99])).toEqual([1, 3]);
      expect(validDoubleHeightRows(4, 1, [2])).toEqual([]);
      expect(validDoubleHeightRows(4, 6, undefined)).toEqual([]);
    });
  });

  describe('x-rack', () => {
    it('default bottlesPerSection (10) → 40 slots', () => {
      expect(computeLayout('x-rack', 1, 1).totalSlots).toBe(40);
    });

    it('bottlesPerSection 6 → 24 slots', () => {
      expect(computeLayout('x-rack', 1, 1, { bottlesPerSection: 6 }).totalSlots).toBe(24);
    });

    it('bottlesPerSection 1 → 4 slots', () => {
      expect(computeLayout('x-rack', 1, 1, { bottlesPerSection: 1 }).totalSlots).toBe(4);
    });

    it('has contiguous positions', () => {
      const layout = computeLayout('x-rack', 1, 1, { bottlesPerSection: 6 });
      const positions = layout.slots.map(s => s.position).sort((a, b) => a - b);
      expect(positions).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    });
  });

  describe('hex', () => {
    it('3 rows, 4 cols → 11 slots', () => {
      expect(computeLayout('hex', 3, 4).totalSlots).toBe(11);
    });

    it('1 row, 5 cols → 5 slots', () => {
      expect(computeLayout('hex', 1, 5).totalSlots).toBe(5);
    });

    it('4 rows, 3 cols → 10 slots', () => {
      expect(computeLayout('hex', 4, 3).totalSlots).toBe(10);
    });

    describe('hexFlip', () => {
      it('is a no-op for an odd row count (the unflipped sequence is a palindrome)', () => {
        const unflipped = computeLayout('hex', 3, 4);
        const flipped = computeLayout('hex', 3, 4, { hexFlip: true });
        expect(flipped).toEqual(unflipped);
      });

      it('swaps which row is short for an even row count, without changing total slots', () => {
        const unflipped = computeLayout('hex', 4, 3);
        const flipped = computeLayout('hex', 4, 3, { hexFlip: true });
        expect(flipped.totalSlots).toBe(unflipped.totalSlots);

        const rowSize = (layout) => layout.slots.filter(s => s.cy === layout.slots[0].cy).length;
        // Unflipped row 0 is full width (3 cols); flipped row 0 mirrors the
        // old last row, which is short (2 cols).
        expect(rowSize(unflipped)).toBe(3);
        expect(rowSize(flipped)).toBe(2);
      });
    });
  });

  describe('triangle', () => {
    it('base 4 → 10 slots', () => {
      expect(computeLayout('triangle', 1, 4).totalSlots).toBe(10);
    });

    it('base 5 → 15 slots', () => {
      expect(computeLayout('triangle', 1, 5).totalSlots).toBe(15);
    });

    it('base 1 → 1 slot', () => {
      expect(computeLayout('triangle', 1, 1).totalSlots).toBe(1);
    });
  });

  describe('stack', () => {
    it('returns rows slots', () => {
      expect(computeLayout('stack', 6, 1).totalSlots).toBe(6);
    });

    it('1 high → 1 slot', () => {
      expect(computeLayout('stack', 1, 1).totalSlots).toBe(1);
    });
  });

  describe('cube', () => {
    it('2×2 outer, default 2×2 modules → 16', () => {
      expect(computeLayout('cube', 2, 2).totalSlots).toBe(16);
    });

    it('3×2 outer, 3×3 modules → 54', () => {
      expect(computeLayout('cube', 3, 2, { moduleRows: 3, moduleCols: 3 }).totalSlots).toBe(54);
    });
  });

  describe('shelf', () => {
    it('3 rows, 2 cols → 6 slots (bpc=1 default)', () => {
      expect(computeLayout('shelf', 3, 2).totalSlots).toBe(6);
    });

    it('2 rows, 3 cols with bpc=4 → 24 slots', () => {
      const layout = computeLayout('shelf', 2, 3, { bottlesPerCell: 4 });
      expect(layout.totalSlots).toBe(24);
      expect(layout.bottlesPerCell).toBe(4);
    });

    it('positions sharing same cell have identical coordinates', () => {
      const layout = computeLayout('shelf', 1, 1, { bottlesPerCell: 4 });
      expect(layout.totalSlots).toBe(4);
      const uniqueCoords = new Set(layout.slots.map(s => `${s.cx},${s.cy}`));
      expect(uniqueCoords.size).toBe(1);
    });
  });

  describe('unknown type falls back to grid', () => {
    it('returns rows × cols', () => {
      expect(computeLayout('nonexistent', 3, 5).totalSlots).toBe(15);
    });
  });

  describe('all types have valid coordinates', () => {
    const cases = [
      ['grid', 4, 8, undefined],
      ['grid', 4, 6, { doubleHeightRows: [1, 3] }],
      ['x-rack', 1, 1, { bottlesPerSection: 6 }],
      ['hex', 4, 5, undefined],
      ['triangle', 1, 5, undefined],
      ['stack', 8, 1, undefined],
      ['cube', 2, 3, { moduleRows: 2, moduleCols: 2 }],
      ['shelf', 3, 2, undefined],
      ['shelf', 2, 3, { bottlesPerCell: 4 }],
    ];

    test.each(cases)('%s layout has positive coordinates within viewBox', (type, rows, cols, tc) => {
      const layout = computeLayout(type, rows, cols, tc);
      expect(layout.totalSlots).toBeGreaterThan(0);
      expect(layout.viewBox.width).toBeGreaterThan(0);
      expect(layout.viewBox.height).toBeGreaterThan(0);

      layout.slots.forEach(slot => {
        expect(slot.cx).toBeGreaterThanOrEqual(SLOT_RADIUS);
        expect(slot.cy).toBeGreaterThanOrEqual(SLOT_RADIUS);
        expect(slot.cx).toBeLessThanOrEqual(layout.viewBox.width);
        expect(slot.cy).toBeLessThanOrEqual(layout.viewBox.height);
      });
    });

    test.each(cases)('%s layout has contiguous positions 1..N', (type, rows, cols, tc) => {
      const layout = computeLayout(type, rows, cols, tc);
      const positions = layout.slots.map(s => s.position).sort((a, b) => a - b);
      const expected = Array.from({ length: layout.totalSlots }, (_, i) => i + 1);
      expect(positions).toEqual(expected);
    });
  });
});

describe('computeModularLayout', () => {
  it('returns empty layout for no modules', () => {
    const layout = computeModularLayout([]);
    expect(layout.totalSlots).toBe(0);
    expect(layout.slots).toHaveLength(0);
    expect(layout.moduleLayouts).toHaveLength(0);
  });

  it('returns empty layout for null', () => {
    const layout = computeModularLayout(null);
    expect(layout.totalSlots).toBe(0);
  });

  it('single grid module matches computeLayout', () => {
    const single = computeLayout('grid', 3, 4);
    const modular = computeModularLayout([{ type: 'grid', rows: 3, cols: 4 }]);
    expect(modular.totalSlots).toBe(single.totalSlots);
    expect(modular.slots).toHaveLength(single.slots.length);
    // Positions should match
    expect(modular.slots.map(s => s.position)).toEqual(single.slots.map(s => s.position));
    // Coordinates should match (no offset)
    modular.slots.forEach((s, i) => {
      expect(s.cx).toBe(single.slots[i].cx);
      expect(s.cy).toBe(single.slots[i].cy);
    });
  });

  it('two modules have contiguous global positions', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 2, cols: 3 },    // 6 slots
      { type: 'stack', rows: 4, cols: 1, x: 5 },  // 4 slots
    ]);
    expect(layout.totalSlots).toBe(10);
    const positions = layout.slots.map(s => s.position);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('offset modules have shifted coordinates', () => {
    const CELL = 48; // SLOT_R*2 + SLOT_GAP = 20*2+8
    const layout = computeModularLayout([
      { type: 'grid', rows: 1, cols: 1, x: 0, y: 0 },
      { type: 'grid', rows: 1, cols: 1, x: 3, y: 2 },
    ]);
    // Second module's slot should be offset by 3*CELL, 2*CELL
    const slot2 = layout.slots[1];
    const slot1 = layout.slots[0];
    expect(slot2.cx - slot1.cx).toBe(3 * CELL);
    expect(slot2.cy - slot1.cy).toBe(2 * CELL);
  });

  it('moduleLayouts has correct metadata', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 2, cols: 3, x: 0, y: 0 },
      { type: 'hex', rows: 2, cols: 3, x: 5, y: 0 },
    ]);
    expect(layout.moduleLayouts).toHaveLength(2);
    expect(layout.moduleLayouts[0].moduleIndex).toBe(0);
    expect(layout.moduleLayouts[0].slotCount).toBe(6);
    expect(layout.moduleLayouts[1].moduleIndex).toBe(1);
    expect(layout.moduleLayouts[1].slotCount).toBe(5); // hex 2×3 = 2+2=5 (alternating)
  });

  it('slots include moduleIndex', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 1, cols: 2 },
      { type: 'stack', rows: 3, cols: 1, x: 3 },
    ]);
    expect(layout.slots[0].moduleIndex).toBe(0);
    expect(layout.slots[1].moduleIndex).toBe(0);
    expect(layout.slots[2].moduleIndex).toBe(1);
    expect(layout.slots[3].moduleIndex).toBe(1);
    expect(layout.slots[4].moduleIndex).toBe(1);
  });

  it('mixed module types sum correctly', () => {
    const layout = computeModularLayout([
      { type: 'grid', rows: 3, cols: 4 },       // 12
      { type: 'hex', rows: 3, cols: 4 },         // 11
      { type: 'stack', rows: 6, cols: 1 },        // 6
    ]);
    expect(layout.totalSlots).toBe(29);
  });
});

describe('getModularTotalSlots', () => {
  it('returns 0 for empty/null', () => {
    expect(getModularTotalSlots([])).toBe(0);
    expect(getModularTotalSlots(null)).toBe(0);
  });

  it('matches computeModularLayout totalSlots', () => {
    const modules = [
      { type: 'grid', rows: 3, cols: 4 },
      { type: 'hex', rows: 3, cols: 4 },
      { type: 'stack', rows: 5, cols: 1 },
    ];
    const layout = computeModularLayout(modules);
    expect(getModularTotalSlots(modules)).toBe(layout.totalSlots);
  });

  it('sums mixed types correctly', () => {
    // grid 3×4 = 12, hex 3×4 = 11, stack 6 = 6 → 29
    expect(getModularTotalSlots([
      { type: 'grid', rows: 3, cols: 4 },
      { type: 'hex', rows: 3, cols: 4 },
      { type: 'stack', rows: 6, cols: 1 },
    ])).toBe(29);
  });
});

describe('getTotalSlots', () => {
  it('shelf with bpc=1', () => {
    expect(getTotalSlots('shelf', 3, 2)).toBe(6);
  });

  it('shelf with bpc=4', () => {
    expect(getTotalSlots('shelf', 2, 3, { bottlesPerCell: 4 })).toBe(24);
  });

  it('x-rack with bottlesPerSection=6', () => {
    expect(getTotalSlots('x-rack', 1, 1, { bottlesPerSection: 6 })).toBe(24);
  });

  it('matches computeLayout for all types', () => {
    const cases = [
      ['grid', 4, 8, undefined],
      ['grid', 4, 6, { doubleHeightRows: [2, 4] }],
      ['x-rack', 1, 1, { bottlesPerSection: 6 }],
      ['hex', 4, 5, undefined],
      ['triangle', 1, 5, undefined],
      ['stack', 8, 1, undefined],
      ['cube', 2, 3, { moduleRows: 2, moduleCols: 2 }],
      ['shelf', 3, 2, undefined],
    ];
    cases.forEach(([type, rows, cols, tc]) => {
      expect(getTotalSlots(type, rows, cols, tc)).toBe(computeLayout(type, rows, cols, tc).totalSlots);
    });
  });
});
