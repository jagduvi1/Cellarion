import { describe, it, expect } from 'vitest';
import { getCabinetGeometry, computeCabinetSlotPositions, BOTTLE_LENGTH, BOTTLE_RADIUS } from './roomConstants';

// The 3D room's cabinet bottles (support forum 2026-10-13: a slim fridge lays
// one bottle across the front of each shelf, and fills its bottom bin with
// bottles lying across). Plain geometry — no three.js needed.
const WIDTH = 0.6;
const PITCH = BOTTLE_RADIUS * 2 + 0.004;

function slotsOf(typeConfig, rows, cols, width = WIDTH) {
  const rack = { type: 'cabinet', rows, cols, typeConfig };
  const cab = getCabinetGeometry(rack);
  return { cab, slots: computeCabinetSlotPositions(cab, width, cab.depth) };
}
// The click target of every slot (what EmptySlot / DisabledSlotDisc use).
const targets = (slots) => slots.map(({ position, x, y, z }) => ({ position, x, y, z }));

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

  // Release audit 2026-10-13: targets spread along a pile, or a target at the
  // front of the shelf, overlapped their neighbours — a click could pick the
  // wrong slot. Only the bottles move; the targets stay the ordinary grid.
  it('every click target is the ordinary cabinet\'s, so targets never overlap', () => {
    for (const tc of [
      { ...base, shelfSideways: ['front', 'all'] },
      { shelfRows: [4, 2], twoDeep: true, shelfSideways: ['all', 'front'] },
      { shelfRows: [1, 1], twoDeep: false, headToTail: true, shelfSideways: ['front', ''] },
    ]) {
      const plain = { ...tc };
      delete plain.shelfSideways;
      const rows = tc.shelfRows.length;
      expect(targets(slotsOf(tc, rows, 6).slots)).toEqual(targets(slotsOf(plain, rows, 6).slots));
    }
  });

  // Forum 2026-10-14: a stacked one-deep shelf with a bottle across the front
  // is a different shape (one bottle fewer on each level above), so there the
  // levels above are drawn AND clicked where they lie: never on each other,
  // never on the first row.
  it("'front' on a stacked one-deep shelf: the upper level's targets are where its bottles lie, apart", () => {
    const { slots } = slotsOf({ shelfRows: [3], shelfCols: [5], shelfAlternate: [false], twoDeep: false, headToTail: true, shelfSideways: ['front'] }, 1, 6);
    expect(slots.map((s) => s.position)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1)); // 5 + 4 + 4
    for (const s of slots.slice(5)) expect(s.bottleX).toBeUndefined();
    const byLevel = (y) => slots.filter((s) => s.y === y).map((s) => s.x);
    for (const y of new Set(slots.map((s) => s.y))) {
      const xs = byLevel(y).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThan(0.01);
    }
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
      expect(slots[i].bottleZ).toBeCloseTo(plain[i].bottleZ - PITCH);
    }
    // Four bottles behind it, centred on the shelf (one bottle narrower).
    const xs = slots.slice(1, 5).map((s) => s.bottleX);
    const plainXs = plain.slice(0, 5).map((s) => s.x);
    expect((xs[0] + xs[3]) / 2).toBeCloseTo((plainXs[0] + plainXs[4]) / 2);
    // The bay below is untouched.
    expect(slots.slice(5)).toEqual(plain.slice(5));
  });

  // Forum 2026-10-14: the Atelier Duo's top shelf, 1 across + 4 with 3 in the
  // grooves on top. It used to stack 4 on the 3 beside the bottle across.
  it("'front' on a stacked one-deep shelf: the level above lies in the grooves of the bottles behind the one across", () => {
    const tc = { shelfRows: [2], shelfCols: [5], shelfAlternate: [true], twoDeep: false, stagger: true, shelfSideways: ['front'] };
    const { slots } = slotsOf(tc, 1, 5);
    expect(slots).toHaveLength(8);
    expect(slots[0].sideways).toBe(true);
    const behind = slots.slice(1, 5).map((s) => s.bottleX);
    const top = slots.slice(5).map((s) => s.x);
    expect(top).toHaveLength(3);
    top.forEach((x, i) => expect(x).toBeCloseTo((behind[i] + behind[i + 1]) / 2));
    expect(slots[5].y).toBeGreaterThan(slots[1].y);
    // Without alternating rows the level above holds as many as the row
    // behind the bottle across, staggered half a bottle over it.
    const equal = slotsOf({ ...tc, shelfAlternate: [false] }, 1, 5).slots;
    expect(equal).toHaveLength(9);
    const eqBehind = equal.slice(1, 5).map((s) => s.bottleX);
    const half = (eqBehind[1] - eqBehind[0]) / 2;
    equal.slice(5).forEach((s, i) => expect(s.x).toBeCloseTo(eqBehind[i] + half));
  });

  it("'front' two deep: the back rows stay put and the front rows interleave with them", () => {
    const tc = { shelfRows: [2], twoDeep: true };
    const plain = slotsOf(tc, 1, 4).slots;
    const { slots } = slotsOf({ ...tc, shelfSideways: ['front'] }, 1, 4);
    for (const s of slots.filter((x) => x.isBack)) {
      const p = plain.find((x) => x.position === s.position);
      expect(s.bottleX).toBeUndefined();
      expect(s.bottleZ).toBeCloseTo(p.bottleZ);
    }
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
  });

  it('a pile longer than the cabinet is deep packs tighter — not even a bottle\'s edge pokes out the back', () => {
    for (const [tc, rows, cols] of [
      [{ shelfRows: [1], twoDeep: false, shelfSideways: ['all'] }, 1, 8],
      [{ shelfRows: [2], twoDeep: false, stagger: true, shelfSideways: ['all'] }, 1, 5],
      [{ shelfRows: [2], twoDeep: true, shelfSideways: ['all'] }, 1, 6],
      [{ shelfRows: [3], twoDeep: true, alternate: true, shelfSideways: ['all'] }, 1, 6],
    ]) {
      const { cab, slots } = slotsOf(tc, rows, cols);
      for (const s of slots) expect(s.bottleZ - BOTTLE_RADIUS).toBeGreaterThanOrEqual(-cab.depth / 2 - 1e-9);
    }
  });

  it('two deep, alternating: a level shifts as a whole — no half-overlapping bottles inside a level', () => {
    const { slots } = slotsOf({ shelfRows: [4], twoDeep: true, alternate: true, shelfSideways: ['all'] }, 1, 4);
    const byLevel = {};
    for (const s of slots) (byLevel[s.y.toFixed(5)] = byLevel[s.y.toFixed(5)] || []).push(s.bottleZ);
    for (const zs of Object.values(byLevel)) {
      const sorted = [...zs].sort((a, b) => b - a);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1] - sorted[i]).toBeGreaterThan(BOTTLE_RADIUS);
    }
  });

  it('a cabinet narrower than a bottle is long shrinks the lying bottle to fit', () => {
    const narrow = 0.21; // two bottles across
    const { slots } = slotsOf({ shelfRows: [1], twoDeep: false, shelfSideways: ['all'] }, 1, 2, narrow);
    for (const s of slots) {
      expect(s.bottleScale).toBeLessThan(1);
      expect(-s.bottleX * 2).toBeLessThanOrEqual(narrow);
    }
    expect(slotsOf({ shelfRows: [1], twoDeep: false, shelfSideways: ['all'] }, 1, 6).slots[0].bottleScale).toBe(1);
  });
});
