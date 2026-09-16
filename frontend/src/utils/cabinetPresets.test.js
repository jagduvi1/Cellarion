import { describe, it, expect } from 'vitest';
import { CABINET_PRESETS, CABINET_PRESET_GROUPS, CABINET_DEFAULT, fitShelfRows, cabinetCapacity } from './cabinetPresets';
import { getTotalSlots } from './rackLayouts';

describe('cabinetPresets', () => {
  it('every preset is a complete, valid starting shape', () => {
    for (const p of CABINET_PRESETS) {
      expect(CABINET_PRESET_GROUPS).toContain(p.group);
      expect(p.shelfRows).toHaveLength(p.shelves);
      expect(fitShelfRows(p.shelfRows, p.shelves)).toEqual(p.shelfRows);
      expect(p.cols).toBeGreaterThanOrEqual(1);
      expect(p.cols).toBeLessThanOrEqual(20);
    }
    expect(CABINET_DEFAULT.shelfRows).toHaveLength(CABINET_DEFAULT.shelves);
    expect(CABINET_DEFAULT.alternate).toBe(false);
  });

  it('cabinetCapacity agrees with the layout engine for every preset, alternating or not', () => {
    for (const p of CABINET_PRESETS) {
      const typeConfig = { shelfRows: p.shelfRows, twoDeep: p.twoDeep, alternate: p.alternate === true };
      expect(cabinetCapacity(p.cols, p.shelfRows, typeConfig)).toBe(getTotalSlots('cabinet', p.shelves, p.cols, typeConfig));
    }
    // Without a typeConfig it is the plain cols × Σ rows.
    expect(cabinetCapacity(6, [2, 3])).toBe(30);
    expect(cabinetCapacity(6, [2, 3], { alternate: true })).toBe(11 + 16);
  });

  it('the Liebherr GrandCru 5001 preset alternates 6 / 5: three exact honeycomb shelves of 44, 198 in all', () => {
    const p = CABINET_PRESETS.find((x) => x.key === 'liebherrWpbl5001');
    expect(p).toMatchObject({ group: 'liebherrGrandCru', cols: 6, twoDeep: true, alternate: true, capacity: 196 });
    expect(p.shelfRows).toEqual([6, 8, 8, 8, 6]);
    expect(cabinetCapacity(6, [8], p)).toBe(44); // 6/5, 5/6, 6/5, 5/6 — the manual's middle shelf
    expect(cabinetCapacity(p.cols, p.shelfRows, p)).toBe(198);
  });

  it('a maker figure is within a couple of bottles of its starting shape', () => {
    for (const p of CABINET_PRESETS.filter((x) => x.capacity)) {
      expect(Math.abs(cabinetCapacity(p.cols, p.shelfRows, p) - p.capacity)).toBeLessThanOrEqual(3);
    }
  });
});
