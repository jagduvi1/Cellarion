import { describe, it, expect } from 'vitest';
import { buildSections } from './wineListSections';

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
