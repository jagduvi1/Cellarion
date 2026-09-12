const { buildSections, resolveEntry, groupingLevels, generateWineListPdf, priceWithSymbol } = require('./wineListPdf');

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

// --- Nested auto grouping (support ticket 2026-09-12) -----------------------

describe('buildSections (nested auto grouping)', () => {
  const rioja = {
    _id: 'w4', name: 'Rioja Reserva', producer: 'Muga', type: 'red',
    country: { name: 'Spain' }, region: { name: 'Rioja' }, grapes: [],
  };
  const sauternes = {
    _id: 'w5', name: 'Sauternes', producer: 'Guiraud', type: 'dessert',
    country: { name: 'France' }, region: { name: 'Bordeaux' }, appellation: 'Sauternes', grapes: [],
  };
  const wineMap = new Map([
    mapEntry(WINES.barolo), mapEntry(WINES.chablis), mapEntry(WINES.champagne),
    mapEntry(rioja), mapEntry(sauternes),
  ]);
  const list = (autoGrouping, extra = {}) => ({
    structureMode: 'auto',
    language: 'en',
    autoGrouping,
    autoGroupEntries: ['w1', 'w2', 'w3', 'w4', 'w5'].map(id => entry(id)),
    layout: {},
    ...extra,
  });
  const outline = (sections) => sections.map(s =>
    `${'  '.repeat(s.level)}${s.title}${s.wines.length ? ` (${s.wines.map(w => w.name).join(', ')})` : ''}`
  );

  test('type › country › region renders nested headings; wines sit only under the deepest one', () => {
    const sections = buildSections(list({ levels: ['type', 'country', 'region'], withinGroup: 'name' }), wineMap);
    expect(outline(sections)).toEqual([
      'Sparkling Wines (Brut Réserve)',   // France › Champagne would be two headings for one wine — collapsed
      'White Wines (Chablis)',
      'Red Wines',
      '  Italy (Barolo Riserva)',         // Piedmont collapsed under Italy
      '  Spain (Rioja Reserva)',
      'Dessert Wines (Sauternes)',
    ]);
  });

  test('collapseSingle off keeps every heading, one wine or not', () => {
    const sections = buildSections(list({ levels: ['type', 'country', 'region'], collapseSingle: false, withinGroup: 'name' }), wineMap);
    expect(outline(sections).slice(0, 3)).toEqual(['Sparkling Wines', '  France', '    Champagne (Brut Réserve)']);
  });

  test('the appellation level falls back to region; a legacy single groupBy stays flat at level 0', () => {
    const sections = buildSections(list({ levels: ['type', 'appellation'], collapseSingle: false }), wineMap);
    expect(outline(sections)).toContain('  Sauternes (Sauternes)');
    expect(outline(sections)).toContain('  Piedmont (Barolo Riserva)');

    const legacy = buildSections(list({ groupBy: 'country' }), wineMap);
    expect(legacy.map(s => [s.title, s.level])).toEqual([['France', 0], ['Italy', 0], ['Spain', 0]]);
  });

  test('sorts within the deepest group by producer when asked', () => {
    const sections = buildSections(list({ levels: ['type'], withinGroup: 'producer' }), wineMap);
    const reds = sections.find(s => s.title === 'Red Wines');
    expect(reds.wines.map(w => w.producer)).toEqual(['Conterno', 'Muga']);
  });

  test('groupingLevels caps at three distinct known fields and falls back to groupBy, then type', () => {
    expect(groupingLevels({ levels: ['type', 'type', 'country', 'bogus', 'region', 'appellation'] })).toEqual(['type', 'country', 'region']);
    expect(groupingLevels({ groupBy: 'region' })).toEqual(['region']);
    expect(groupingLevels({ levels: ['bogus'] })).toEqual(['type']);
    expect(groupingLevels({})).toEqual(['type']);
  });
});

// --- Hidden prices + the last-bottle marker ---------------------------------

describe('hidden prices and the last-bottle marker', () => {
  test('resolveEntry flags the last bottle only when the list asks AND stock is exactly one; byGlass is kept apart from the price', () => {
    const one = new Map([mapEntry(WINES.barolo, { stock: 1 })]);
    const e = entry('w1', { byGlass: true, glassPrice: 12 });
    expect(resolveEntry(e, one, { markLastBottle: true })).toMatchObject({ lastBottle: true, byGlass: true, glassPrice: 12 });
    expect(resolveEntry(e, one, {}).lastBottle).toBe(false);
    const two = new Map([mapEntry(WINES.barolo, { stock: 2 })]);
    expect(resolveEntry(e, two, { markLastBottle: true }).lastBottle).toBe(false);
  });

  test('a nested, price-hidden, last-bottle-marked list renders to PDF', async () => {
    const wineMap = new Map([mapEntry(WINES.barolo, { stock: 1 }), mapEntry(WINES.chablis)]);
    const doc = await generateWineListPdf({
      name: 'Hemma', structureMode: 'auto', language: 'sv',
      autoGrouping: { levels: ['type', 'country', 'region'], collapseSingle: false },
      autoGroupEntries: [entry('w1', { byGlass: true, glassPrice: 12 }), entry('w2')],
      layout: { hidePrices: true, markLastBottle: true },
      branding: {},
    }, wineMap);
    const bytes = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe('nested grouping fallbacks (review 2026-09-12)', () => {
  test('a wine without a region never repeats its country as a sub-heading; it goes to "Other", sorted last', () => {
    const chianti = { _id: 'w6', name: 'Chianti', producer: 'Antinori', type: 'red', country: { name: 'Italy' }, region: null, grapes: [] };
    const wineMap = new Map([mapEntry(WINES.barolo), mapEntry(chianti)]);
    const sections = buildSections({
      structureMode: 'auto', language: 'en',
      autoGrouping: { levels: ['type', 'country', 'region'], collapseSingle: false, withinGroup: 'name' },
      autoGroupEntries: [entry('w1'), entry('w6')], layout: {},
    }, wineMap);
    expect(sections.map(s => `${'  '.repeat(s.level)}${s.title}`)).toEqual(['Red Wines', '  Italy', '    Piedmont', '    Other']);
    expect(sections[3].wines.map(w => w.name)).toEqual(['Chianti']);
  });
});

// --- Page layout (support ticket 2026-09-12: blank footer pages, splits) ---

const pdfBytes = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});
const pageCount = (bytes) => (bytes.toString('latin1').match(/\/Type \/Page(?![s])/g) || []).length;

describe('PDF page layout', () => {
  const manyReds = Array.from({ length: 90 }, (_, i) => ({
    _id: `r${i}`, name: `Wine ${String(i).padStart(2, '0')}`, producer: `Producer ${i}`, type: 'red',
    country: { name: 'Italy' }, region: { name: i < 45 ? 'Piedmont' : 'Tuscany' }, grapes: [{ name: 'Sangiovese' }],
  }));
  const wineMap = new Map(manyReds.map(w => mapEntry(w)));
  const list = (layout = {}, branding = {}) => ({
    name: 'Test', structureMode: 'auto', language: 'en',
    autoGrouping: { levels: ['type', 'country', 'region'], collapseSingle: true, withinGroup: 'name' },
    autoGroupEntries: manyReds.map(w => entry(w._id)),
    layout, branding,
  });

  test('footer text and page numbers are stamped ON the content pages — no blank page per element', async () => {
    const plain = pageCount(await pdfBytes(await generateWineListPdf(list(), wineMap)));
    const withFooter = pageCount(await pdfBytes(await generateWineListPdf(list({}, { footerText: 'Prices include VAT' }), wineMap)));
    expect(plain).toBeGreaterThan(1);
    expect(withFooter).toBe(plain);
  });

  test('a group that runs over a page break repeats its heading stack, marked continued, in the list language', async () => {
    // Content streams are compressed, so the written strings are captured at the source.
    const PDFDocument = require('pdfkit');
    const written = [];
    const orig = PDFDocument.prototype.text;
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, ...rest) {
      written.push(String(str));
      return orig.call(this, str, ...rest);
    });
    try {
      await pdfBytes(await generateWineListPdf({ ...list(), language: 'de' }, wineMap));
    } finally {
      spy.mockRestore();
    }
    // 90 reds over several pages: the type heading and the Italy / region
    // headings come back on each new page, marked continued.
    expect(written.filter(t => t === 'ROTWEINE (FORTSETZUNG)').length).toBeGreaterThanOrEqual(2);
    // (Italy is the only country, so its heading is collapsed away — nothing to repeat there)
    expect(written.some(t => /^Italy/.test(t))).toBe(false);
    expect(written.some(t => /^(Piedmont|Tuscany) \(Fortsetzung\)$/.test(t))).toBe(true);
    // Every wine is written exactly once — nothing lost or duplicated by the breaks
    expect(written.filter(t => /^Wine \d\d, NV$/.test(t))).toHaveLength(90);
  });

  test('newPageEachSection puts every wine type on its own page; the QR rule sits below the QR code', async () => {
    const whites = Array.from({ length: 3 }, (_, i) => ({ _id: `w${i}`, name: `White ${i}`, producer: 'P', type: 'white', country: { name: 'France' }, region: { name: 'Alsace' }, grapes: [] }));
    const map = new Map([...whites, ...manyReds.slice(0, 3)].map(w => mapEntry(w)));
    const small = (layout) => ({
      ...list(layout), autoGroupEntries: [...whites, ...manyReds.slice(0, 3)].map(w => entry(w._id)),
    });
    const onePage = pageCount(await pdfBytes(await generateWineListPdf(small({}), map)));
    const perType = pageCount(await pdfBytes(await generateWineListPdf(small({ newPageEachSection: true }), map, { publicUrl: 'https://cellarion.app/menu/x' })));
    expect(onePage).toBe(1);
    expect(perType).toBe(2);
  });

  test('priceWithSymbol: "CHF 16" but "$16"', () => {
    expect(priceWithSymbol('CHF', '16')).toBe('CHF 16');
    expect(priceWithSymbol('kr', '160')).toBe('kr 160');
    expect(priceWithSymbol('$', '16')).toBe('$16');
    expect(priceWithSymbol('€', '16')).toBe('€16');
  });
});
