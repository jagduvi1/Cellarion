import { describe, it, expect } from 'vitest';
import { CABINET_PRESETS, CABINET_PRESET_GROUPS, CABINET_DEFAULT, fitShelfRows, cabinetCapacity } from './cabinetPresets';
import { getTotalSlots } from './rackLayouts';

describe('cabinetPresets', () => {
  it('every preset is a complete, valid starting shape', () => {
    for (const p of CABINET_PRESETS) {
      expect(CABINET_PRESET_GROUPS).toContain(p.group);
      expect(p.shelfRows).toHaveLength(p.shelves);
      expect(fitShelfRows(p.shelfRows, p.shelves)).toEqual(p.shelfRows);
      if (p.shelfCols) {
        expect(p.shelfCols).toHaveLength(p.shelves);
        p.shelfCols.forEach((w) => { expect(w).toBeGreaterThanOrEqual(1); expect(w).toBeLessThanOrEqual(p.cols); });
      }
      if (p.shelfAlternate) expect(p.shelfAlternate).toHaveLength(p.shelves);
      expect(p.cols).toBeGreaterThanOrEqual(1);
      expect(p.cols).toBeLessThanOrEqual(20);
    }
    expect(CABINET_DEFAULT.shelfRows).toHaveLength(CABINET_DEFAULT.shelves);
    expect(CABINET_DEFAULT.alternate).toBe(false);
  });

  it('cabinetCapacity agrees with the layout engine for every preset, alternating or not', () => {
    for (const p of CABINET_PRESETS) {
      const typeConfig = { shelfRows: p.shelfRows, twoDeep: p.twoDeep, alternate: p.alternate === true, shelfCols: p.shelfCols, shelfAlternate: p.shelfAlternate };
      expect(cabinetCapacity(p.cols, p.shelfRows, typeConfig)).toBe(getTotalSlots('cabinet', p.shelves, p.cols, typeConfig));
    }
    // Without a typeConfig it is the plain cols × Σ rows.
    expect(cabinetCapacity(6, [2, 3])).toBe(30);
    expect(cabinetCapacity(6, [2, 3], { alternate: true })).toBe(11 + 16);
  });

  it('the Liebherr GrandCru 5001 preset is the loading diagram: 4-wide staggered top and bottom, 6/5 honeycomb between, 196', () => {
    const p = CABINET_PRESETS.find((x) => x.key === 'liebherrWpbl5001');
    expect(p).toMatchObject({
      group: 'liebherrGrandCru', cols: 6, twoDeep: true, capacity: 196,
      shelfRows: [8, 8, 8, 8, 8], shelfCols: [4, 6, 6, 6, 4], shelfAlternate: [false, true, true, true, false],
    });
    expect(cabinetCapacity(6, [8], { alternate: true })).toBe(44); // 6/5, 5/6, 6/5, 5/6 — a middle shelf
    expect(cabinetCapacity(4, [8], { alternate: false })).toBe(32); // 4 in front of 4, four levels — top / bottom
    expect(cabinetCapacity(p.cols, p.shelfRows, p)).toBe(196);
  });

  it('a maker figure is within a couple of bottles of its starting shape', () => {
    for (const p of CABINET_PRESETS.filter((x) => x.capacity)) {
      expect(Math.abs(cabinetCapacity(p.cols, p.shelfRows, p) - p.capacity)).toBeLessThanOrEqual(3);
    }
  });
});
