import { groupRacks, groupNames } from './rackGroups';

// Support ticket 2026-09-06 / discussion #1228: several basement racks needed
// a level between the cellar and its racks.
describe('groupRacks', () => {
  test('sections by group in first-seen order, ungrouped racks last, blank groups count as none', () => {
    const racks = [
      { _id: 'a', name: 'Fridge' },
      { _id: 'b', name: 'Left', group: 'Basement' },
      { _id: 'c', name: 'Cooler', group: '  ' },
      { _id: 'd', name: 'Right', group: 'Basement' },
      { _id: 'e', name: 'Hall', group: 'Upstairs' },
    ];
    expect(groupRacks(racks).map((s) => [s.group, s.racks.map((r) => r._id)])).toEqual([
      ['Basement', ['b', 'd']],
      ['Upstairs', ['e']],
      [null, ['a', 'c']],
    ]);
    expect(groupNames(racks)).toEqual(['Basement', 'Upstairs']);
  });

  test('a cellar without groups is one nameless section — the strip looks as before', () => {
    expect(groupRacks([{ _id: 'x', name: 'Only' }])).toEqual([{ group: null, racks: [{ _id: 'x', name: 'Only' }] }]);
    expect(groupNames([{ _id: 'x', name: 'Only' }])).toEqual([]);
    expect(groupRacks([])).toEqual([]);
    expect(groupRacks(undefined)).toEqual([]);
  });
});
