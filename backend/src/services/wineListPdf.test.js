const { buildSections, resolveEntry } = require('./wineListPdf');

// --- Fixtures ---------------------------------------------------------------

const WINES = {
  barolo: {
    _id: 'w1', name: 'Barolo Riserva', producer: 'Conterno', type: 'red',
    country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
  },
  chablis: {
    _id: 'w2', name: 'Chablis', producer: 'Dauvissat', type: 'white',
    country: { name: 'France' }, region: { name: 'Burgundy' }, grapes: [{ name: 'Chardonnay' }],
  },
  champagne: {
    _id: 'w3', name: 'Brut Réserve', producer: 'Billecart', type: 'sparkling',
    country: { name: 'France' }, region: { name: 'Champagne' }, grapes: [],
  },
};

function entry(wineId, overrides = {}) {
  return { wine: wineId, vintage: 'NV', bottleSize: '750ml', listPrice: 50, byGlass: false, glassPrice: null, glassPriceManual: false, sortOrder: 0, ...overrides };
}

function mapEntry(wine, { stock = 3, avgPrice = 20, vintage = 'NV', bottleSize = '750ml' } = {}) {
  return [`${wine._id}|${vintage}|${bottleSize}`, { wine, stock, avgPrice }];
}

// --- resolveEntry -----------------------------------------------------------

describe('resolveEntry', () => {
  const wineMap = new Map([mapEntry(WINES.barolo, { vintage: '2018' })]);

  test('resolves wine + vintage + size with stock', () => {
    const r = resolveEntry(entry('w1', { vintage: '2018', listPrice: 120 }), wineMap);
    expect(r).toMatchObject({
      name: 'Barolo Riserva', producer: 'Conterno', vintage: '2018',
      bottleSize: '750ml', price: 120, stock: 3, grapes: ['Nebbiolo'],
    });
  });

  test('returns null when the wine is missing from the map', () => {
    expect(resolveEntry(entry('w-gone'), wineMap)).toBeNull();
  });

  test('falls back to the average purchase price when no list price set', () => {
    const r = resolveEntry(entry('w1', { vintage: '2018', listPrice: null }), wineMap);
    expect(r.price).toBe(20);
  });

  test('glass price only renders when byGlass is on', () => {
    const off = resolveEntry(entry('w1', { vintage: '2018', glassPrice: 12 }), wineMap);
    expect(off.glassPrice).toBeNull();
    const on = resolveEntry(entry('w1', { vintage: '2018', glassPrice: 12, byGlass: true }), wineMap);
    expect(on.glassPrice).toBe(12);
  });

  test('hideOutOfStock drops zero-stock entries', () => {
    const emptyStock = new Map([mapEntry(WINES.barolo, { vintage: '2018', stock: 0 })]);
    const e = entry('w1', { vintage: '2018' });
    expect(resolveEntry(e, emptyStock, { hideOutOfStock: true })).toBeNull();
    expect(resolveEntry(e, emptyStock, {})).not.toBeNull();
  });
});

// --- buildSections ----------------------------------------------------------

describe('buildSections (auto mode)', () => {
  const wineMap = new Map([
    mapEntry(WINES.barolo),
    mapEntry(WINES.chablis),
    mapEntry(WINES.champagne),
  ]);

  const list = (overrides = {}) => ({
    structureMode: 'auto',
    language: 'en',
    autoGrouping: { groupBy: 'type', withinGroup: 'name' },
    autoGroupEntries: [entry('w1'), entry('w2'), entry('w3')],
    layout: {},
    ...overrides,
  });

  test('groups by type in canonical order with localized titles', () => {
    const sections = buildSections(list(), wineMap);
    expect(sections.map(s => s.title)).toEqual(['Sparkling Wines', 'White Wines', 'Red Wines']);
  });

  test('drops entries whose wine is gone and empty sections', () => {
    const sections = buildSections(list({ autoGroupEntries: [entry('w1'), entry('w-gone')] }), wineMap);
    expect(sections).toHaveLength(1);
    expect(sections[0].wines).toHaveLength(1);
  });

  test('glassSectionFirst prepends a deduped by-the-glass section', () => {
    const sections = buildSections(list({
      language: 'sv',
      autoGroupEntries: [
        entry('w1', { byGlass: true, glassPrice: 14 }),
        entry('w2'),
        entry('w3', { byGlass: true, glassPrice: 11 }),
      ],
      layout: { glassSectionFirst: true },
    }), wineMap);

    expect(sections[0].title).toBe('Viner på glas');
    expect(sections[0].isGlassSection).toBe(true);
    expect(sections[0].wines.map(w => w.name)).toEqual(
      expect.arrayContaining(['Barolo Riserva', 'Brut Réserve'])
    );
    expect(sections[0].wines).toHaveLength(2);
    // Wines stay in their regular sections too
    expect(sections.slice(1).flatMap(s => s.wines)).toHaveLength(3);
  });

  test('hideOutOfStock removes wines with zero stock', () => {
    const stockMap = new Map([
      mapEntry(WINES.barolo, { stock: 0 }),
      mapEntry(WINES.chablis, { stock: 2 }),
    ]);
    const sections = buildSections(list({
      autoGroupEntries: [entry('w1'), entry('w2')],
      layout: { hideOutOfStock: true },
    }), stockMap);
    expect(sections.flatMap(s => s.wines).map(w => w.name)).toEqual(['Chablis']);
  });
});

describe('buildSections (custom mode)', () => {
  const wineMap = new Map([
    mapEntry(WINES.barolo),
    mapEntry(WINES.chablis),
  ]);

  test('respects section and entry sort order, drops empty sections', () => {
    const sections = buildSections({
      structureMode: 'custom',
      layout: {},
      sections: [
        { title: 'Reds', sortOrder: 1, entries: [entry('w1')] },
        { title: 'Whites', sortOrder: 0, entries: [entry('w2')] },
        { title: 'Empty', sortOrder: 2, entries: [] },
      ],
    }, wineMap);

    expect(sections.map(s => s.title)).toEqual(['Whites', 'Reds']);
  });
});
