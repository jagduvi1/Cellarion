import { describe, it, expect } from 'vitest';
import { readBottleViewMode, storeBottleViewMode, VIEW_MODE_KEY } from './bottleViewMode';

const storageWith = (value) => ({
  getItem: (k) => (k === VIEW_MODE_KEY ? value : null),
  setItem() {},
});

describe('readBottleViewMode', () => {
  it('returns the stored list/card preference', () => {
    expect(readBottleViewMode(storageWith('card'))).toBe('card');
    expect(readBottleViewMode(storageWith('list'))).toBe('list');
  });

  it("falls back to the list for the retired 'table' mode", () => {
    // The analytics table moved to the Dashboard page; a browser that last
    // used it must not open a cellar into a mode that is no longer there.
    expect(readBottleViewMode(storageWith('table'))).toBe('list');
  });

  it('falls back to the list for garbage, nothing stored, or no storage', () => {
    expect(readBottleViewMode(storageWith('grid'))).toBe('list');
    expect(readBottleViewMode(storageWith(null))).toBe('list');
    expect(readBottleViewMode(null)).toBe('list');
    expect(readBottleViewMode({ getItem() { throw new Error('denied'); } })).toBe('list');
  });
});

describe('storeBottleViewMode', () => {
  it('writes under the shared key and swallows storage errors', () => {
    const writes = [];
    storeBottleViewMode('card', { setItem: (k, v) => writes.push([k, v]) });
    expect(writes).toEqual([[VIEW_MODE_KEY, 'card']]);
    expect(() => storeBottleViewMode('card', { setItem() { throw new Error('quota'); } })).not.toThrow();
    expect(() => storeBottleViewMode('card', null)).not.toThrow();
  });
});
