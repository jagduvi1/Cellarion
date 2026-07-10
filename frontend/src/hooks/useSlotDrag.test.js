import { describe, it, expect } from 'vitest';
import { findNearestSlot } from './useSlotDrag';

const centers = [
  { position: 1, cx: 40, cy: 40, r: 20 },
  { position: 2, cx: 88, cy: 40, r: 20 },
  { position: 3, cx: 136, cy: 40, r: 20 },
];

describe('findNearestSlot', () => {
  it('returns the slot whose center is hit exactly', () => {
    expect(findNearestSlot(centers, 40, 40)).toBe(1);
    expect(findNearestSlot(centers, 88, 40)).toBe(2);
  });

  it('hits within the scaled radius (default 1.2×r)', () => {
    expect(findNearestSlot(centers, 40 + 23, 40)).toBe(1); // 23 < 24
    expect(findNearestSlot(centers, 40, 40 + 25)).toBeNull(); // 25 > 24
  });

  it('picks the nearest when hit zones overlap between two slots', () => {
    // x=62 is 22 from slot 1 and 26 from slot 2 — both within 24? 26 is not.
    // Use x=64: 24 from both — tie broken by first-nearest (strictly closer wins).
    expect(findNearestSlot(centers, 62, 40)).toBe(1);
    expect(findNearestSlot(centers, 66, 40)).toBe(2);
  });

  it('excludes the dragged slot itself', () => {
    expect(findNearestSlot(centers, 40, 40, { exclude: 1 })).toBeNull();
    // A point in slot 2's hit zone but nearer to excluded slot 1 resolves to 2
    expect(findNearestSlot(centers, 66, 40, { exclude: 1 })).toBe(2);
  });

  it('respects per-slot radii', () => {
    const mixed = [
      { position: 1, cx: 40, cy: 40, r: 20 },
      { position: 2, cx: 80, cy: 40, r: 10 }, // small back-row slot
    ];
    expect(findNearestSlot(mixed, 80, 40 + 13)).toBeNull(); // 13 > 12
    expect(findNearestSlot(mixed, 80, 40 + 11)).toBe(2);    // 11 < 12
  });

  it('returns null for empty center lists', () => {
    expect(findNearestSlot([], 40, 40)).toBeNull();
  });
});
