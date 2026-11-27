import { slotLabel, wallWords } from './slotLabel';

const t = (key, fallback, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

test('a slot with a number names the rack and the slot', () => {
  expect(slotLabel({ rackName: 'Left wall', position: 7 }, t)).toBe('drinkOne.slot:{"rack":"Left wall","position":7}');
});

test('a slot without a number is the rack; no rack says so', () => {
  expect(slotLabel({ rackName: 'Left wall', position: null }, t)).toBe('Left wall');
  expect(slotLabel(null, t)).toBe('drinkOne.unplaced');
});

// The English with its values filled in, as the app shows it.
const en = (key, fallback, vars) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '');
const pile = (box, kind, section, slot) => ({ box, kind, section, slot, row: null, col: null });
const cell = (box, kind, row, col) => ({ box, kind, section: null, slot: null, row, col });

test('a bottle in a wall rack is named by its box and the spot in it', () => {
  expect(wallWords(pile('B2', 'x', 'left', 3), en)).toBe('B2 left · 3');
  expect(wallWords(pile('A1', 'slash', 'upper', 14), en)).toBe('A1 upper · 14');
  expect(wallWords(pile('A3', 'bin', null, 12), en)).toBe('A3 · 12');
  expect(wallWords(cell('A1', 'rack', 2, 3), en)).toBe('A1 · row 2, 3');
  expect(wallWords(cell('C1', 'shelves', 2, 3), en)).toBe('C1 · shelf 2, 3');
  expect(wallWords(null, en)).toBe('');
});

test('each pile of a box has a word of its own', () => {
  const words = ['top', 'left', 'right', 'bottom', 'upper', 'lower'].map((s) => wallWords(pile('A1', 'x', s, 1), en));
  expect(words).toEqual(['A1 top · 1', 'A1 left · 1', 'A1 right · 1', 'A1 bottom · 1', 'A1 upper · 1', 'A1 lower · 1']);
});

test('in a wall rack the slot number gives way to the box and the spot', () => {
  const label = slotLabel({ rackName: 'Cellar wall', position: 98, wall: pile('B2', 'x', 'left', 3) }, en);
  expect(label).toBe('Cellar wall · B2 left · 3');
  expect(label).not.toMatch(/98|slot/);
});
