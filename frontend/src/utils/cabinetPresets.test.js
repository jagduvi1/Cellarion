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

  it('the Liebherr GrandCru 5001 preset alternates 6 / 5 and lands on the maker\'s 196 bottles', () => {
    const p = CABINET_PRESETS.find((x) => x.key === 'liebherrWpbl5001');
    expect(p).toMatchObject({ group: 'liebherrGrandCru', cols: 6, twoDeep: true, alternate: true, capacity: 196 });
    expect(cabinetCapacity(p.cols, p.shelfRows, p)).toBe(196);
  });

  it('a maker figure is within a couple of bottles of its starting shape', () => {
    for (const p of CABINET_PRESETS.filter((x) => x.capacity)) {
      expect(Math.abs(cabinetCapacity(p.cols, p.shelfRows, p) - p.capacity)).toBeLessThanOrEqual(3);
    }
  });
});
