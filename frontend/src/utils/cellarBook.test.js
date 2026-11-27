import { describe, it, expect } from 'vitest';
import { buildCellarBook, formatDrinkWindow } from './cellarBook';

const wine = (name) => ({ name, producer: 'P' });
const bottle = (id, name, extra = {}) => ({ _id: id, wineDefinition: wine(name), ...extra });

const rackA = {
  _id: 'rackA',
  name: 'Rack A',
  type: 'grid',
  rows: 2,
  cols: 3,
  slots: [
    { position: 5, bottle: bottle('b2', 'Zinfandel') },
    { position: 1, bottle: bottle('b1', 'Barolo') },
    { position: 3, bottle: null },
  ],
};

const rackB = {
  _id: 'rackB',
  name: 'Rack B',
  type: 'grid',
  rows: 1,
  cols: 2,
  disabledPositions: [2],
  slots: [],
};

describe('buildCellarBook', () => {
  const bottles = [
    bottle('b1', 'Barolo'),
    bottle('b2', 'Zinfandel'),
    bottle('b3', 'Chablis'),
    bottle('b4', 'Amarone'),
  ];
  const book = buildCellarBook([rackA, rackB], bottles);

  it('creates one section per rack with entries sorted by position', () => {
    expect(book.rackSections).toHaveLength(2);
    expect(book.rackSections[0].entries.map(e => e.position)).toEqual([1, 5]);
  });

  it('a wall rack tells each entry its box and the spot in it; another rack does not', () => {
    // A1 an X of six a triangle (positions 1 to 24), B1 a rack of 3 by 4 (25 to 36).
    const wall = {
      _id: 'w', name: 'Cellar wall', type: 'wall', rows: 1, cols: 2,
      typeConfig: { boxes: [
        { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
        { x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
      ] },
      slots: [{ position: 30, bottle: bottles[1] }, { position: 8, bottle: bottles[0] }],
    };
    const [section] = buildCellarBook([wall], bottles).rackSections;
    expect(section.entries.map(e => [e.position, e.wall])).toEqual([
      [8, { box: 'A1', kind: 'x', section: 'left', slot: 2, row: null, col: null }],
      [30, { box: 'B1', kind: 'rack', section: null, slot: null, row: 2, col: 2 }],
    ]);
    expect(section.totalSlots).toBe(36);
    expect(book.rackSections[0].entries.every(e => e.wall === null)).toBe(true);
  });

  it('skips empty slots and counts filled/total (minus disabled)', () => {
    expect(book.rackSections[0].filledCount).toBe(2);
    expect(book.rackSections[0].totalSlots).toBe(6);
    expect(book.rackSections[1].filledCount).toBe(0);
    expect(book.rackSections[1].totalSlots).toBe(1); // 2 slots − 1 disabled
  });

  it('lists unplaced bottles sorted by wine name', () => {
    expect(book.unplaced.map(b => b.wineDefinition.name)).toEqual(['Amarone', 'Chablis']);
  });

  it('counts placed and total active bottles', () => {
    expect(book.placedCount).toBe(2);
    expect(book.totalActive).toBe(4);
  });

  it('handles unpopulated slot bottles (raw ids) without crashing', () => {
    const rawRack = { _id: 'r', name: 'R', type: 'grid', rows: 1, cols: 1, slots: [{ position: 1, bottle: 'b9' }] };
    const result = buildCellarBook([rawRack], [bottle('b9', 'Rioja')]);
    expect(result.rackSections[0].filledCount).toBe(1);
    expect(result.unplaced).toHaveLength(0); // id matched even unpopulated
  });

  it('tolerates empty inputs', () => {
    const empty = buildCellarBook([], []);
    expect(empty.rackSections).toEqual([]);
    expect(empty.unplaced).toEqual([]);
    expect(empty.placedCount).toBe(0);
  });

  it('supports modular racks via getModularTotalSlots', () => {
    const modular = {
      _id: 'm', name: 'M', isModular: true,
      modules: [{ type: 'grid', rows: 2, cols: 2 }, { type: 'stack', rows: 3, cols: 1 }],
      slots: [],
    };
    expect(buildCellarBook([modular], []).rackSections[0].totalSlots).toBe(7);
  });
});

describe('formatDrinkWindow', () => {
  it('renders a full personal window as years', () => {
    expect(formatDrinkWindow({ drinkFrom: 2024, drinkTo: 2030 })).toEqual({ text: '2024–2030' });
  });

  it('renders open-ended personal windows', () => {
    expect(formatDrinkWindow({ drinkFrom: 2024 })).toEqual({ text: '2024–' });
    expect(formatDrinkWindow({ drinkTo: 2030 })).toEqual({ text: '–2030' });
  });

  it('personal window wins over maturityStatus', () => {
    expect(formatDrinkWindow({ drinkFrom: 2024, drinkTo: 2030, maturityStatus: 'declining' }))
      .toEqual({ text: '2024–2030' });
  });

  it('falls back to the maturityStatus translation key', () => {
    expect(formatDrinkWindow({ maturityStatus: 'peak' })).toEqual({ tKey: 'maturity.peak' });
    expect(formatDrinkWindow({ maturityStatus: 'not-ready' })).toEqual({ tKey: 'maturity.notReady' });
  });

  it('returns null when nothing is known', () => {
    expect(formatDrinkWindow({})).toBeNull();
    expect(formatDrinkWindow({ maturityStatus: null })).toBeNull();
    expect(formatDrinkWindow(undefined)).toBeNull();
  });
});
