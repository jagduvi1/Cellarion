import { freePositions, planAutoPlace, readPlaceQueue, rackTotalSlots } from './placeQueue';

const grid = (over = {}) => ({ type: 'grid', rows: 2, cols: 3, slots: [], disabledPositions: [], ...over });

describe('placeQueue helpers (issue #1055)', () => {
  test('freePositions walks the rack in order, skipping occupied and disabled slots', () => {
    const rack = grid({ slots: [{ position: 1 }, { position: 4 }], disabledPositions: [2] });
    expect(rackTotalSlots(rack)).toBe(6);
    expect(freePositions(rack)).toEqual([3, 5, 6]);
    expect(freePositions(rack, { from: 5 })).toEqual([5, 6]);
  });

  test('planAutoPlace pairs bottles with the first free slots and reports what did not fit', () => {
    const rack = grid({ slots: [{ position: 1 }, { position: 2 }, { position: 3 }, { position: 4 }] });
    const { pairs, leftover } = planAutoPlace(rack, ['a', 'b', 'c']);
    expect(pairs).toEqual([{ position: 5, bottleId: 'a' }, { position: 6, bottleId: 'b' }]);
    expect(leftover).toEqual(['c']);
  });

  test('planAutoPlace with room to spare places everything', () => {
    const { pairs, leftover } = planAutoPlace(grid(), ['a', 'b']);
    expect(pairs.map((p) => p.position)).toEqual([1, 2]);
    expect(leftover).toEqual([]);
  });

  test('readPlaceQueue accepts only well-formed ids from the router state', () => {
    expect(readPlaceQueue(null)).toEqual([]);
    expect(readPlaceQueue({ placeQueue: 'nope' })).toEqual([]);
    expect(readPlaceQueue({ placeQueue: ['64b0000000000000000000b1', 'junk', 42] })).toEqual(['64b0000000000000000000b1']);
  });
});
