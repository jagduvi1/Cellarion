import { describe, it, expect } from 'vitest';
import { buildSections, groupingLevels, localName } from './wineListSections';

const WINES = {
  barolo: {
    _id: 'w1', name: 'Barolo Riserva', producer: 'Conterno', type: 'red',
    country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
  },
  chablis: {
    _id: 'w2', name: 'Chablis', producer: 'Dauvissat', type: 'white',
    country: { name: 'France' }, region: { name: 'Burgundy' }, grapes: [{ name: 'Chardonnay' }],
  },
};

const entry = (wineId, overrides = {}) => ({
  wine: wineId, vintage: 'NV', bottleSize: '750ml', listPrice: 50,
  byGlass: false, glassPrice: null, glassPriceManual: false, sortOrder: 0,
  ...overrides,
});

const item = (wine, overrides = {}) => ({
  wine, vintage: 'NV', bottleSize: '750ml', stock: 3, avgPrice: 20, ...overrides,
});

const mapOf = (...items) =>
  new Map(items.map(i => [`${i.wine._id}|${i.vintage}|${i.bottleSize}`, i]));

describe('buildSections', () => {
  const winesByKey = mapOf(item(WINES.barolo), item(WINES.chablis));

  it('groups auto entries by type with localized titles', () => {
    const sections = buildSections({
      structureMode: 'auto',
      language: 'sv',
      autoGrouping: { groupBy: 'type', withinGroup: 'name' },
      autoGroupEntries: [entry('w1'), entry('w2')],
      layout: {},
    }, winesByKey);

    expect(sections.map(s => s.title)).toEqual(['Vita Viner', 'Röda Viner']);
  });

  it('drops entries whose wine is missing and applies hideOutOfStock', () => {
    const stockMap = mapOf(item(WINES.barolo, { stock: 0 }), item(WINES.chablis));
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { groupBy: 'type' },
      autoGroupEntries: [entry('w1'), entry('w2'), entry('w-gone')],
      layout: { hideOutOfStock: true },
    }, stockMap);

    expect(sections.flatMap(s => s.wines).map(w => w.name)).toEqual(['Chablis']);
  });

  it('only exposes glass prices for byGlass entries', () => {
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { groupBy: 'type' },
      autoGroupEntries: [
        entry('w1', { glassPrice: 14 }),
        entry('w2', { byGlass: true, glassPrice: 11 }),
      ],
      layout: {},
    }, winesByKey);

    const byName = Object.fromEntries(sections.flatMap(s => s.wines).map(w => [w.name, w.glassPrice]));
    expect(byName['Barolo Riserva']).toBeNull();
    expect(byName['Chablis']).toBe(11);
  });

  it('prepends a deduped Wines by the Glass section when enabled', () => {
    const sections = buildSections({
      structureMode: 'auto',
      language: 'en',
      autoGrouping: { groupBy: 'type' },
      autoGroupEntries: [
        entry('w1', { byGlass: true, glassPrice: 14 }),
        entry('w2'),
      ],
      layout: { glassSectionFirst: true },
    }, winesByKey);

    expect(sections[0].title).toBe('Wines by the Glass');
    expect(sections[0].wines.map(w => w.name)).toEqual(['Barolo Riserva']);
    expect(sections.slice(1).flatMap(s => s.wines)).toHaveLength(2);
  });

  it('orders custom sections and entries by sortOrder, dropping empty ones', () => {
    const sections = buildSections({
      structureMode: 'custom',
      layout: {},
      sections: [
        { title: 'Reds', sortOrder: 1, entries: [entry('w1')] },
        { title: 'Whites', sortOrder: 0, entries: [entry('w2')] },
        { title: 'Empty', sortOrder: 2, entries: [] },
      ],
    }, winesByKey);

    expect(sections.map(s => s.title)).toEqual(['Whites', 'Reds']);
  });

  it('falls back from list price to the average purchase price', () => {
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { groupBy: 'type' },
      autoGroupEntries: [entry('w1', { listPrice: null })],
      layout: {},
    }, winesByKey);

    expect(sections[0].wines[0].price).toBe(20);
  });
});

describe('nested auto grouping, hidden prices and the last-bottle marker (support ticket 2026-09-12)', () => {
  const rioja = {
    _id: 'w4', name: 'Rioja Reserva', producer: 'Muga', type: 'red',
    country: { name: 'Spain' }, region: { name: 'Rioja' }, grapes: [],
  };
  const winesByKey = mapOf(item(WINES.barolo, { stock: 1 }), item(WINES.chablis), item(rioja));
  const outline = (sections) => sections.map(s =>
    `${'  '.repeat(s.level)}${s.title}${s.wines.length ? ` (${s.wines.map(w => w.name).join(', ')})` : ''}`
  );

  it('renders type › country › region as nested levels, skipping a heading that would hold one group', () => {
    const sections = buildSections({
      structureMode: 'auto',
      language: 'en',
      autoGrouping: { levels: ['type', 'country', 'region'], withinGroup: 'producer' },
      autoGroupEntries: [entry('w1'), entry('w2'), entry('w4')],
      layout: {},
    }, winesByKey);
    expect(outline(sections)).toEqual([
      'White Wines (Chablis)',
      'Red Wines',
      '  Italy (Barolo Riserva)',
      '  Spain (Rioja Reserva)',
    ]);
  });

  it('keeps every heading when collapseSingle is off, and stays flat for a legacy groupBy', () => {
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { levels: ['type', 'country'], collapseSingle: false },
      autoGroupEntries: [entry('w2')],
      layout: {},
    }, winesByKey);
    expect(outline(sections)).toEqual(['White Wines', '  France (Chablis)']);

    const legacy = buildSections({
      structureMode: 'auto',
      autoGrouping: { groupBy: 'country' },
      autoGroupEntries: [entry('w1'), entry('w2')],
      layout: {},
    }, winesByKey);
    expect(legacy.map(s => [s.title, s.level])).toEqual([['France', 0], ['Italy', 0]]);
  });

  it('marks the last bottle only when the list asks and stock is exactly one; byGlass survives hidden prices', () => {
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { levels: ['type'] },
      autoGroupEntries: [entry('w1', { byGlass: true, glassPrice: 14 }), entry('w2')],
      layout: { markLastBottle: true, hidePrices: true },
    }, winesByKey);
    const byName = Object.fromEntries(sections.flatMap(s => s.wines).map(w => [w.name, w]));
    expect(byName['Barolo Riserva']).toMatchObject({ lastBottle: true, byGlass: true, glassPrice: 14 });
    expect(byName['Chablis'].lastBottle).toBe(false);
  });

  it('groupingLevels caps at three distinct known fields and falls back to groupBy', () => {
    expect(groupingLevels({ levels: ['type', 'country', 'region', 'appellation'] })).toEqual(['type', 'country', 'region']);
    expect(groupingLevels({ levels: ['region', 'region', 'bogus'] })).toEqual(['region']);
    expect(groupingLevels({ groupBy: 'country' })).toEqual(['country']);
    expect(groupingLevels({})).toEqual(['type']);
  });
});

describe('nested grouping fallbacks (review 2026-09-12)', () => {
  it('a wine without a region never repeats its country as a sub-heading; it goes to "Other", sorted last', () => {
    const chianti = { _id: 'w6', name: 'Chianti', producer: 'Antinori', type: 'red', country: { name: 'Italy' }, region: null, grapes: [] };
    const sections = buildSections({
      structureMode: 'auto',
      autoGrouping: { levels: ['type', 'country', 'region'], collapseSingle: false, withinGroup: 'name' },
      autoGroupEntries: [entry('w1'), entry('w6')],
      layout: {},
    }, mapOf(item(WINES.barolo), item(chianti)));
    expect(sections.map(s => `${'  '.repeat(s.level)}${s.title}`)).toEqual(['Red Wines', '  Italy', '    Piedmont', '    Other']);
  });
});

describe('geography in the list language (support ticket 2026-09-12)', () => {
  const tuscan = {
    _id: 'g1', name: 'Brunello', producer: 'Biondi-Santi', type: 'red',
    country: { name: 'Italy', translations: { de: 'Italien' } },
    region: { name: 'Tuscany', translations: { de: 'Toskana' } }, grapes: [],
  };
  const bordeaux = {
    _id: 'g2', name: 'Pauillac', producer: 'Lynch-Bages', type: 'red',
    country: { name: 'France', translations: { de: 'Frankreich' } },
    region: { name: 'Bordeaux' }, grapes: [],
  };
  const byKey = mapOf(item(tuscan), item(bordeaux));

  it('prints Toskana on a German list and leaves Bordeaux alone; English is unchanged', () => {
    const outline = (language) => buildSections({
      structureMode: 'auto', language,
      autoGrouping: { levels: ['type', 'country', 'region'], collapseSingle: false, withinGroup: 'name' },
      autoGroupEntries: [entry('g1'), entry('g2')], layout: {},
    }, byKey).map(s => `${'  '.repeat(s.level)}${s.title}`);
    expect(outline('de')).toEqual(['Rotweine', '  Frankreich', '    Bordeaux', '  Italien', '    Toskana']);
    expect(outline('en')).toEqual(['Red Wines', '  France', '    Bordeaux', '  Italy', '    Tuscany']);
  });

  it('localName falls back to the canonical name', () => {
    expect(localName({ name: 'Rioja', translations: { de: '' } }, 'de')).toBe('Rioja');
    expect(localName({ name: 'Rioja' }, 'sv')).toBe('Rioja');
    expect(localName(null, 'de')).toBe('');
  });
});
