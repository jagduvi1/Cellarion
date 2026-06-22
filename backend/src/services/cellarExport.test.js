const {
  mapBottlesForExport,
  collectImageFiles,
  urlToArchivePath,
} = require('./cellarExport');

// Minimal stand-ins for lean Mongoose docs. _id only needs a stable toString().
const oid = (s) => ({ toString: () => s });

describe('urlToArchivePath', () => {
  test('maps a local upload URL into the images/ folder', () => {
    expect(urlToArchivePath('/api/uploads/originals/abc.jpg')).toBe('images/originals/abc.jpg');
    expect(urlToArchivePath('/api/uploads/processed/abc.png')).toBe('images/processed/abc.png');
  });

  test('returns null for non-local / empty URLs', () => {
    expect(urlToArchivePath(null)).toBeNull();
    expect(urlToArchivePath('')).toBeNull();
    expect(urlToArchivePath('https://cdn.example.com/x.jpg')).toBeNull();
    expect(urlToArchivePath(42)).toBeNull();
  });
});

describe('mapBottlesForExport', () => {
  test('emits import-aligned fields and resolves rack placement', () => {
    const bottles = [{
      _id: oid('b1'),
      vintage: '2018',
      bottleSize: '750ml',
      price: 25,
      currency: 'EUR',
      rating: 90,
      ratingScale: '100',
      notes: 'lovely',
      createdAt: new Date('2024-01-02T10:00:00Z'),
      wineDefinition: { name: 'Château Test', producer: 'Dom Test', type: 'red', appellation: 'Médoc', country: { name: 'France' }, region: { name: 'Bordeaux' } },
    }];
    // 8-column rack; position 10 → row 2, col 2.
    const racks = [{ name: 'Rack A', cols: 8, slots: [{ position: 10, bottle: oid('b1') }] }];

    const [item] = mapBottlesForExport(bottles, racks);
    expect(item).toMatchObject({
      wineName: 'Château Test',
      producer: 'Dom Test',
      vintage: '2018',
      country: 'France',
      region: 'Bordeaux',
      appellation: 'Médoc',
      type: 'red',
      price: 25,
      currency: 'EUR',
      rating: 90,
      ratingScale: '100',
      notes: 'lovely',
      dateAdded: '2024-01-02',
      rackName: 'Rack A',
      rackPosition: 10,
      rackRow: 2,
      rackCol: 2,
    });
    // No images map passed → no images key (legacy no-images behaviour).
    expect(item).not.toHaveProperty('images');
  });

  test('emits rackPosition for a shelf rack but NOT the (grid-only) row/col', () => {
    // For non-grid racks the cols-based row/col math is wrong, so the export must
    // only carry rackPosition (the internal slot) and let the importer round-trip
    // it via internalSlot. Emitting bogus row/col would mislead other tools.
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const shelfRack = [{ name: 'Cabinet', type: 'shelf', cols: 6, slots: [{ position: 111, bottle: oid('b1') }] }];
    const [item] = mapBottlesForExport(bottles, shelfRack);
    expect(item.rackName).toBe('Cabinet');
    expect(item.rackPosition).toBe(111);
    expect(item).not.toHaveProperty('rackRow');
    expect(item).not.toHaveProperty('rackCol');
  });

  test('flags consumed bottles for the history importer', () => {
    const bottles = [{
      _id: oid('b1'),
      vintage: 'NV',
      status: 'drank',
      consumedReason: 'drank',
      consumedAt: new Date('2024-05-01T00:00:00Z'),
      consumedNote: 'birthday',
      consumedRating: 4,
      consumedRatingScale: '5',
      wineDefinition: { name: 'W', producer: 'P' },
    }];
    const [item] = mapBottlesForExport(bottles, []);
    expect(item).toMatchObject({
      addToHistory: true,
      consumedReason: 'drank',
      consumedAt: '2024-05-01',
      consumedNote: 'birthday',
      consumedRating: 4,
      consumedRatingScale: '5',
    });
  });

  test('exports the cropped image only — never the pre-crop original', () => {
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const imagesByBottle = new Map([['b1', [
      { originalUrl: '/api/uploads/originals/a.jpg', processedUrl: '/api/uploads/processed/a.png', credit: 'me' },
      { originalUrl: 'https://remote/x.jpg', processedUrl: null }, // no local file → dropped
    ]]]);

    const [item] = mapBottlesForExport(bottles, [], imagesByBottle);
    // Image 1 has a processed (cropped) version → only that is emitted, no original.
    expect(item.images).toEqual([
      { processed: 'images/processed/a.png', credit: 'me' },
    ]);
  });

  test('falls back to the original only when there is no cropped version', () => {
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const imagesByBottle = new Map([['b1', [
      { originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null, credit: 'me' },
    ]]]);
    const [item] = mapBottlesForExport(bottles, [], imagesByBottle);
    expect(item.images).toEqual([{ original: 'images/originals/a.jpg', credit: 'me' }]);
  });

  test('omits the images key when a bottle has none', () => {
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const [item] = mapBottlesForExport(bottles, [], new Map());
    expect(item).not.toHaveProperty('images');
  });

  test('nests the user reviews tied to a bottle', () => {
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const reviewsByBottle = new Map([['b1', [
      { rating: 4, ratingScale: '5', vintage: '2018', tasting: { overall: 'lovely' }, visibility: 'public', createdAt: new Date('2024-01-01') },
    ]]]);
    const [item] = mapBottlesForExport(bottles, [], new Map(), reviewsByBottle);
    expect(item.reviews).toEqual([
      { rating: 4, ratingScale: '5', vintage: '2018', tasting: { overall: 'lovely' }, visibility: 'public', createdAt: new Date('2024-01-01') },
    ]);
  });

  test('omits the reviews key when a bottle has none', () => {
    const bottles = [{ _id: oid('b1'), vintage: 'NV', wineDefinition: { name: 'W' } }];
    const [item] = mapBottlesForExport(bottles, [], new Map(), new Map());
    expect(item).not.toHaveProperty('reviews');
  });

  test('emits the sommelier maturity window for the bottle wine+vintage', () => {
    const bottles = [{ _id: oid('b1'), vintage: '2018', wineDefinition: { _id: oid('w1'), name: 'W' } }];
    const profiles = new Map([['w1:2018', {
      relative: false, earlyFrom: 2022, peakFrom: 2026, peakUntil: 2032, lateUntil: 2038, sommNotes: 'hold',
    }]]);
    const [item] = mapBottlesForExport(bottles, [], new Map(), new Map(), profiles);
    expect(item.maturity).toEqual({ earlyFrom: 2022, peakFrom: 2026, peakUntil: 2032, lateUntil: 2038, sommNotes: 'hold' });
    // relative is false → not emitted (keeps the block lean).
    expect(item.maturity).not.toHaveProperty('relative');
  });

  test('carries the relative flag for NV-style offset windows', () => {
    const bottles = [{ _id: oid('b1'), vintage: '2020', wineDefinition: { _id: oid('w1'), name: 'W' } }];
    const profiles = new Map([['w1:2020', { relative: true, earlyFrom: 0, peakFrom: 3 }]]);
    const [item] = mapBottlesForExport(bottles, [], new Map(), new Map(), profiles);
    expect(item.maturity).toEqual({ relative: true, earlyFrom: 0, peakFrom: 3 });
  });

  test('omits maturity for NV vintages, missing profiles, and empty windows', () => {
    const make = (vintage, wdId) => [{ _id: oid('b1'), vintage, wineDefinition: { _id: oid(wdId), name: 'W' } }];
    const profiles = new Map([
      ['w1:2018', { relative: false, peakFrom: 2026 }],
      ['w2:2019', { relative: true }], // reviewed but no window numbers → noise, skip
    ]);
    // NV vintage is never matched.
    expect(mapBottlesForExport(make('NV', 'w1'), [], new Map(), new Map(), profiles)[0]).not.toHaveProperty('maturity');
    // No profile for this wine+vintage.
    expect(mapBottlesForExport(make('2018', 'wX'), [], new Map(), new Map(), profiles)[0]).not.toHaveProperty('maturity');
    // Profile present but carries no usable window boundaries.
    expect(mapBottlesForExport(make('2019', 'w2'), [], new Map(), new Map(), profiles)[0]).not.toHaveProperty('maturity');
  });
});

describe('collectImageFiles', () => {
  test('bundles only the cropped file (original as fallback), skips non-local URLs', () => {
    const images = [
      { originalUrl: '/api/uploads/originals/a.jpg', processedUrl: '/api/uploads/processed/a.png' }, // has crop → processed only
      { originalUrl: '/api/uploads/originals/c.jpg', processedUrl: null },                            // no crop → original fallback
      { originalUrl: 'https://remote/x.jpg', processedUrl: '/api/uploads/processed/b.png' },          // crop local, original remote
    ];
    const files = collectImageFiles(images);
    expect(files).toEqual([
      { relPath: 'processed/a.png', archivePath: 'images/processed/a.png' },
      { relPath: 'originals/c.jpg', archivePath: 'images/originals/c.jpg' },
      { relPath: 'processed/b.png', archivePath: 'images/processed/b.png' },
    ]);
  });
});
