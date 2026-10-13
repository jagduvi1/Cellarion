import { describe, it, expect } from 'vitest';
import { getCabinetGeometry, computeCabinetSlotPositions, BOTTLE_LENGTH, BOTTLE_RADIUS } from './roomConstants';

// The 3D room's cabinet bottles (support forum 2026-10-13: a slim fridge lays
// one bottle across the front of each shelf, and fills its bottom bin with
// bottles lying across). Plain geometry — no three.js needed.
const WIDTH = 0.6;

function slotsOf(typeConfig, rows, cols) {
  const rack = { type: 'cabinet', rows, cols, typeConfig };
  const cab = getCabinetGeometry(rack);
  return { cab, slots: computeCabinetSlotPositions(cab, WIDTH, cab.depth) };
}

describe('computeCabinetSlotPositions — bottles lying sideways', () => {
  const base = { shelfRows: [1, 2], shelfCols: [5, 4], shelfAlternate: [false, true], twoDeep: false };

  it('a list of front-to-back shelves draws exactly as no list at all', () => {
    const plain = slotsOf(base, 2, 5).slots;
    const blank = slotsOf({ ...base, shelfSideways: ['', ''] }, 2, 5).slots;
    expect(blank).toEqual(plain);
  });

  it('keeps every position, in order, whatever lies sideways', () => {
    const { slots } = slotsOf({ ...base, shelfSideways: ['front', 'all'] }, 2, 5);
    expect(slots.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("'front': the first bottle lies across the front, the shelf's other bottles sit one bottle further in", () => {
    const plain = slotsOf(base, 2, 5).slots;
    const { cab, slots } = slotsOf({ ...base, shelfSideways: ['front', ''] }, 2, 5);
    const across = slots[0];
    expect(across.sideways).toBe(true);
    // Centred across the cabinet: base at −L/2, neck at +L/2.
    expect(across.bottleX).toBeCloseTo(-BOTTLE_LENGTH / 2);
    // In front of the bottles behind it, inside the cabinet.
    expect(across.bottleZ).toBeGreaterThan(slots[1].bottleZ);
    expect(across.bottleZ + BOTTLE_RADIUS).toBeLessThanOrEqual(cab.depth / 2);
    for (let i = 1; i < 5; i++) {
      expect(slots[i].sideways).toBeUndefined();
      expect(slots[i].bottleZ).toBeCloseTo(plain[i].bottleZ - (BOTTLE_RADIUS * 2 + 0.004));
    }
    // Four bottles behind it, centred on the shelf (one bottle narrower).
    const xs = slots.slice(1, 5).map((s) => s.x);
    const plainXs = plain.slice(0, 5).map((s) => s.x);
    expect((xs[0] + xs[3]) / 2).toBeCloseTo((plainXs[0] + plainXs[4]) / 2);
    // The bay below is untouched.
    expect(slots.slice(5)).toEqual(plain.slice(5));
  });

  it("'all': a pile of bottles lying across, front to back, inside the cabinet's depth", () => {
    const { cab, slots } = slotsOf({ ...base, shelfSideways: ['', 'all'] }, 2, 5);
    const bin = slots.slice(5); // 4 + 3, alternating
    expect(bin).toHaveLength(7);
    for (const s of bin) {
      expect(s.sideways).toBe(true);
      expect(s.bottleX).toBeCloseTo(-BOTTLE_LENGTH / 2);
      expect(s.bottleZ + BOTTLE_RADIUS).toBeLessThanOrEqual(cab.depth / 2 + 1e-9);
      expect(s.bottleZ - BOTTLE_RADIUS).toBeGreaterThanOrEqual(-cab.depth / 2 - 1e-9);
    }
    // First level: four, from the front inwards; the second (narrow) level
    // nests above, half a bottle further in.
    const level1 = bin.slice(0, 4);
    const level2 = bin.slice(4);
    for (let i = 1; i < 4; i++) expect(level1[i].bottleZ).toBeLessThan(level1[i - 1].bottleZ);
    expect(level2[0].y).toBeGreaterThan(level1[0].y);
    expect(level2[0].bottleZ).toBeLessThan(level1[0].bottleZ);
    // Empty targets spread along the bottle so each one can be picked.
    expect(new Set(level1.map((s) => s.x.toFixed(4))).size).toBe(4);
  });

  it('a pile longer than the cabinet is deep packs tighter instead of poking out the back', () => {
    const { cab, slots } = slotsOf({ shelfRows: [1], twoDeep: false, shelfSideways: ['all'] }, 1, 8);
    expect(slots).toHaveLength(8);
    const back = slots[slots.length - 1];
    expect(back.bottleZ).toBeGreaterThanOrEqual(-cab.depth / 2);
  });
});
