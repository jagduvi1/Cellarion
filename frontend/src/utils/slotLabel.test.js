import { slotLabel } from './slotLabel';

const t = (key, fallback, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

test('a slot with a number names the rack and the slot', () => {
  expect(slotLabel({ rackName: 'Left wall', position: 7 }, t)).toBe('drinkOne.slot:{"rack":"Left wall","position":7}');
});

test('a slot without a number is the rack; no rack says so', () => {
  expect(slotLabel({ rackName: 'Left wall', position: null }, t)).toBe('Left wall');
  expect(slotLabel(null, t)).toBe('drinkOne.unplaced');
});
