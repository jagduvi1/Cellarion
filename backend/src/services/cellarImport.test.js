// services/search.js eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform. The pure helpers under test don't touch search, so stub
// the module to keep this suite DB/Meili-free (matches the repo's unit-test style).
jest.mock('./search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  indexBottle: async () => {},
  bulkIndexBottles: () => {},
  removeBottle: async () => {},
}));

// attachMaturity is the only DB-touching helper under test here; mock the model
// so the create/never-overwrite logic can be asserted without a live MongoDB
// (the full round-trip is covered by the Docker smoke test).
jest.mock('../models/WineVintageProfile', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

// attachImages: mock the model so the sanitize/skip/write logic can be
// asserted without a live MongoDB; disk writes are spied on instead of
// hitting /app/uploads (which doesn't exist outside the container).
jest.mock('../models/BottleImage', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

const fs = require('fs');
const sharp = require('sharp');

const {
  parseCellarExport,
  archivePathToUrl,
  resolveTargets,
  exportBottleToItem,
  attachMaturity,
  attachImages,
  EXPORT_SCHEMA,
  MAX_IMPORT_CELLARS,
  MAX_IMPORT_BOTTLES,
} = require('./cellarImport');
const WineVintageProfile = require('../models/WineVintageProfile');
const BottleImage = require('../models/BottleImage');

sharp.cache(false);

describe('parseCellarExport', () => {
  test('accepts the cellar-nested cellarion-export@1 format', () => {
    const doc = {
      schema: EXPORT_SCHEMA,
      cellars: [
        { cellarName: 'Main', description: 'd', racks: [{ name: 'R', type: 'grid', rows: 2, cols: 6 }], bottles: [{ wineName: 'W' }] },
      ],
    };
    const out = parseCellarExport(JSON.stringify(doc));
    expect(out.cellars).toHaveLength(1);
    expect(out.cellars[0]).toMatchObject({ cellarName: 'Main', description: 'd' });
    expect(out.cellars[0].racks).toHaveLength(1);
    expect(out.cellars[0].bottles).toHaveLength(1);
  });

  test('accepts an object (not only a string)', () => {
    const out = parseCellarExport({ cellars: [{ cellarName: 'X', bottles: [] }] });
    expect(out.cellars[0].cellarName).toBe('X');
  });

  test('defaults a missing cellar name and coerces missing arrays', () => {
    const out = parseCellarExport({ cellars: [{}] });
    expect(out.cellars[0].cellarName).toBe('Imported cellar 1');
    expect(out.cellars[0].racks).toEqual([]);
    expect(out.cellars[0].bottles).toEqual([]);
  });

  test('carries the 3D room layout through', () => {
    const layout = { roomDimensions: { width: 8, depth: 6, height: 3 }, rackPlacements: [{ rackName: 'R', position: { x: 1, y: 0, z: 2 }, rotation: 90, wall: 'north' }] };
    const out = parseCellarExport({ cellars: [{ cellarName: 'C', layout, bottles: [] }] });
    expect(out.cellars[0].layout).toEqual(layout);
  });

  test('layout defaults to null when absent or not an object', () => {
    expect(parseCellarExport({ cellars: [{ cellarName: 'C', bottles: [] }] }).cellars[0].layout).toBeNull();
    expect(parseCellarExport({ cellars: [{ cellarName: 'C', layout: 'x', bottles: [] }] }).cellars[0].layout).toBeNull();
  });

  test('legacy flat {bottles:[]} becomes one unnamed cellar', () => {
    const out = parseCellarExport({ bottles: [{ wineName: 'A' }, { wineName: 'B' }] });
    expect(out.cellars).toHaveLength(1);
    expect(out.cellars[0].cellarName).toBe('Imported cellar');
    expect(out.cellars[0].bottles).toHaveLength(2);
  });

  test('legacy bare array of bottles is accepted', () => {
    const out = parseCellarExport([{ wineName: 'A' }]);
    expect(out.cellars[0].bottles).toHaveLength(1);
  });

  test('rejects invalid JSON', () => {
    expect(() => parseCellarExport('{not json')).toThrow(/valid JSON/);
  });

  test('rejects an unsupported schema', () => {
    expect(() => parseCellarExport({ schema: 'cellarion-export@2', cellars: [{ bottles: [] }] }))
      .toThrow(/Unsupported export schema/);
  });

  test('rejects an unrecognised shape', () => {
    expect(() => parseCellarExport({ foo: 'bar' })).toThrow(/Unrecognised export format/);
  });

  test('rejects an empty cellars array', () => {
    expect(() => parseCellarExport({ cellars: [] })).toThrow(/no cellars/);
  });

  test('throws 400-tagged errors', () => {
    try { parseCellarExport('nope'); } catch (e) { expect(e.status).toBe(400); }
  });

  test('rejects an import with too many cellars (DoS bound)', () => {
    const cellars = Array.from({ length: MAX_IMPORT_CELLARS + 1 }, (_, i) => ({ cellarName: `C${i}`, bottles: [] }));
    expect(() => parseCellarExport({ cellars })).toThrow(/too many cellars/i);
  });

  test('rejects an import with too many bottles in total (DoS bound)', () => {
    const bottles = Array.from({ length: MAX_IMPORT_BOTTLES + 1 }, () => ({ wineName: 'W' }));
    expect(() => parseCellarExport({ cellars: [{ cellarName: 'C', bottles }] })).toThrow(/too many bottles/i);
    // Same bound applies to the legacy flat {bottles:[]} shape.
    expect(() => parseCellarExport({ bottles })).toThrow(/too many bottles/i);
  });

  test('allows an import right at the bottle limit', () => {
    const bottles = Array.from({ length: 3 }, () => ({ wineName: 'W' }));
    expect(parseCellarExport({ cellars: [{ cellarName: 'C', bottles }] }).cellars[0].bottles).toHaveLength(3);
  });
});

describe('archivePathToUrl', () => {
  test('reverses the export images/ mapping', () => {
    expect(archivePathToUrl('images/originals/a.jpg')).toBe('/api/uploads/originals/a.jpg');
    expect(archivePathToUrl('images/processed/a.png')).toBe('/api/uploads/processed/a.png');
  });
  test('returns null for non-image paths', () => {
    expect(archivePathToUrl('data.json')).toBeNull();
    expect(archivePathToUrl(null)).toBeNull();
    expect(archivePathToUrl(42)).toBeNull();
  });
});

describe('resolveTargets', () => {
  const cellars = [{ cellarName: 'Cave A' }, { cellarName: 'Cave B' }];

  test('marks overwrite when the (default) name matches an existing cellar', () => {
    const existing = new Set(['cave a']);
    const out = resolveTargets(cellars, existing);
    expect(out[0]).toMatchObject({ sourceName: 'Cave A', targetName: 'Cave A', mode: 'overwrite', collides: true });
    expect(out[1]).toMatchObject({ sourceName: 'Cave B', targetName: 'Cave B', mode: 'create', collides: false });
  });

  test('a rename to a non-existing name creates a new cellar', () => {
    const existing = new Set(['cave a']);
    const out = resolveTargets(cellars, existing, { 'Cave A': 'Cave A (copy)' });
    expect(out[0]).toMatchObject({ targetName: 'Cave A (copy)', mode: 'create', collides: false });
  });

  test('a rename onto an existing name overwrites that one', () => {
    const existing = new Set(['cave a', 'cellar x']);
    const out = resolveTargets([{ cellarName: 'Cave B' }], existing, { 'Cave B': 'Cellar X' });
    expect(out[0]).toMatchObject({ targetName: 'Cellar X', mode: 'overwrite', collides: true });
  });

  test('name matching is case-insensitive and trims', () => {
    const existing = new Set(['main']);
    const out = resolveTargets([{ cellarName: 'X' }], existing, { X: '  MAIN  ' });
    expect(out[0]).toMatchObject({ targetName: 'MAIN', mode: 'overwrite' });
  });
});

describe('exportBottleToItem', () => {
  test('maps export bottle fields to importer item fields (rackRow/Col → row/col)', () => {
    const item = exportBottleToItem({
      wineName: 'W', producer: 'P', vintage: '2019', country: 'France',
      price: 30, currency: 'EUR', rating: 90, ratingScale: '100',
      rackName: 'R1', rackPosition: 7, rackRow: 2, rackCol: 1,
      addToHistory: true, consumedReason: 'drank',
    });
    expect(item).toMatchObject({
      wineName: 'W', producer: 'P', vintage: '2019', country: 'France',
      price: 30, currency: 'EUR', rating: 90, ratingScale: '100',
      rackName: 'R1', rackPosition: 7, row: 2, col: 1,
      addToHistory: true, consumedReason: 'drank',
    });
  });

  test('defaults vintage to NV and coerces missing strings', () => {
    const item = exportBottleToItem({});
    expect(item.vintage).toBe('NV');
    expect(item.wineName).toBe('');
    expect(item.addToHistory).toBe(false);
    expect(item.reviews).toEqual([]);
  });

  test('flags rackPosition as an internal slot so non-grid racks round-trip', () => {
    // The export always stores Cellarion's resolved internal slot index, so the
    // importer must treat it as identity (not a shelf number) for any rack type.
    expect(exportBottleToItem({ wineName: 'W', rackName: 'Shelf', rackPosition: 111 }).internalSlot).toBe(true);
    // No placement → no internal-slot claim (falls through to row/col logic).
    expect(exportBottleToItem({ wineName: 'W' }).internalSlot).toBe(false);
  });

  test('carries the bottle reviews through', () => {
    const reviews = [{ rating: 4, ratingScale: '5', tasting: { overall: 'nice' }, visibility: 'public' }];
    const item = exportBottleToItem({ wineName: 'W', reviews });
    expect(item.reviews).toEqual(reviews);
  });

  test('carries the cellar journey through (addedToCellarAt + cellarHistory)', () => {
    const cellarHistory = [{ cellarName: 'A', enteredAt: '2026-01-02T00:00:00.000Z' }, { cellarName: 'B', enteredAt: '2026-03-05T00:00:00.000Z' }];
    const item = exportBottleToItem({ wineName: 'W', addedToCellarAt: '2026-03-05T00:00:00.000Z', cellarHistory });
    expect(item.addedToCellarAt).toBe('2026-03-05T00:00:00.000Z');
    expect(item.cellarHistory).toEqual(cellarHistory);
    expect(exportBottleToItem({ wineName: 'W' }).cellarHistory).toBeUndefined();
  });

  test('carries the maturity window through, defaulting to null when absent', () => {
    const maturity = { peakFrom: 2026, peakUntil: 2032, sommNotes: 'hold' };
    expect(exportBottleToItem({ wineName: 'W', maturity }).maturity).toEqual(maturity);
    expect(exportBottleToItem({ wineName: 'W' }).maturity).toBeNull();
    expect(exportBottleToItem({ wineName: 'W', maturity: 'x' }).maturity).toBeNull();
  });
});

describe('attachMaturity', () => {
  const mockExisting = (existing) =>
    WineVintageProfile.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(existing) }) });
  const freshResult = () => ({ maturityCreated: 0, maturitySkipped: 0 });

  beforeEach(() => jest.clearAllMocks());

  test('creates a reviewed profile when the destination has none', async () => {
    mockExisting(null);
    WineVintageProfile.create.mockResolvedValue({});
    const result = freshResult();
    await attachMaturity({ relative: false, peakFrom: 2026, peakUntil: 2032, sommNotes: 'hold' }, 'w1', '2018', result, new Set());
    expect(WineVintageProfile.create).toHaveBeenCalledWith(expect.objectContaining({
      wineDefinition: 'w1', vintage: '2018', status: 'reviewed', peakFrom: 2026, peakUntil: 2032,
    }));
    expect(result.maturityCreated).toBe(1);
    expect(result.maturitySkipped).toBe(0);
  });

  test('never overwrites an existing profile (create-only)', async () => {
    mockExisting({ _id: 'p1' });
    const result = freshResult();
    await attachMaturity({ peakFrom: 2026 }, 'w1', '2018', result, new Set());
    expect(WineVintageProfile.create).not.toHaveBeenCalled();
    expect(result.maturitySkipped).toBe(1);
  });

  test('skips NV vintage, missing wine and empty windows without querying', async () => {
    const result = freshResult();
    const seen = new Set();
    await attachMaturity({ peakFrom: 2026 }, 'w1', 'NV', result, seen);   // NV
    await attachMaturity({ peakFrom: 2026 }, null, '2018', result, seen); // no wine
    await attachMaturity({ sommNotes: 'x' }, 'w1', '2018', result, seen); // no window numbers
    await attachMaturity(null, 'w1', '2019', result, seen);               // no maturity
    expect(WineVintageProfile.findOne).not.toHaveBeenCalled();
    expect(result.maturityCreated).toBe(0);
  });

  test('deduplicates by wine+vintage via the seen set', async () => {
    mockExisting(null);
    WineVintageProfile.create.mockResolvedValue({});
    const result = freshResult();
    const seen = new Set();
    await attachMaturity({ peakFrom: 2026 }, 'w1', '2018', result, seen);
    await attachMaturity({ peakFrom: 2026 }, 'w1', '2018', result, seen); // same key → no-op
    expect(WineVintageProfile.create).toHaveBeenCalledTimes(1);
    expect(result.maturityCreated).toBe(1);
  });
});

describe('attachImages sanitization (SECURITY_AUDIT L-13)', () => {
  // ZIP-extracted bytes are attacker-controlled: every buffer must pass
  // through sanitizeImageBuffer() (magic-byte check, pixel cap, EXIF/GPS
  // strip) before fs.writeFileSync — and a bad image must be SKIPPED with a
  // recorded warning, never fail the import.
  let writeSpy;

  const freshResult = () => ({
    imagesAttached: 0, imagesDeduped: 0, imagesSkipped: 0, errors: [],
  });
  const freshBottle = () => ({ _id: 'b1', wineDefinition: null, save: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    // No byte-identical image on record → always take the write path.
    BottleImage.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    BottleImage.create.mockImplementation(async (doc) => ({ _id: 'img1', ...doc }));
  });

  afterEach(() => writeSpy.mockRestore());

  async function jpegWithExif() {
    return sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withMetadata({
        exif: { IFD0: { Make: 'TestCam' }, GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } },
      })
      .toBuffer();
  }

  test('a bad image is skipped with a per-image warning; the good one is still written', async () => {
    const good = await jpegWithExif();
    const files = {
      'images/good.jpg': good,
      'images/bad.png': Buffer.from('definitely not an image'),
    };
    const result = freshResult();

    await attachImages(
      freshBottle(),
      [{ original: 'images/bad.png' }, { original: 'images/good.jpg' }],
      'u1',
      (p) => files[p] || null,
      result,
      new Map(),
      3 // sourceIndex of the bottle in the import
    );

    expect(result.imagesAttached).toBe(1);
    expect(result.imagesSkipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ index: 3 });
    expect(result.errors[0].reason).toMatch(/images\/bad\.png/);
    expect(writeSpy).toHaveBeenCalledTimes(1);       // only the good image reached disk
    expect(BottleImage.create).toHaveBeenCalledTimes(1);
  });

  test('the written buffer is sanitized (EXIF/GPS stripped) — not the raw ZIP bytes', async () => {
    const good = await jpegWithExif();
    expect((await sharp(good).metadata()).exif).toBeDefined(); // raw bytes DO carry EXIF

    const result = freshResult();
    await attachImages(
      freshBottle(), [{ original: 'images/gps.jpg' }], 'u1',
      () => good, result, new Map(), 0
    );

    const [writtenPath, writtenBuf] = writeSpy.mock.calls[0];
    expect(writtenBuf).not.toEqual(good);
    const meta = await sharp(writtenBuf).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('jpeg');
    expect(String(writtenPath)).toMatch(/\.jpg$/);
  });

  test('the file extension follows the actual bytes, not the archive filename', async () => {
    // A real JPEG smuggled under a "processed …png" archive name must be
    // written as .jpg (the sanitizer preserves the decoded format).
    const jpeg = await jpegWithExif();
    const result = freshResult();

    await attachImages(
      freshBottle(), [{ processed: 'images/liar.png' }], 'u1',
      () => jpeg, result, new Map(), 0
    );

    const [writtenPath] = writeSpy.mock.calls[0];
    expect(String(writtenPath)).toMatch(/\.jpg$/);
    expect(BottleImage.create).toHaveBeenCalledWith(
      expect.objectContaining({ processedUrl: expect.stringMatching(/\.jpg$/) })
    );
    expect(result.imagesAttached).toBe(1);
  });

  test('all images bad → nothing written, import result still sane', async () => {
    const result = freshResult();
    const bottle = freshBottle();

    await attachImages(
      bottle, [{ original: 'a.jpg' }, { original: 'b.jpg' }], 'u1',
      () => Buffer.from('junk bytes that are not an image'), result, new Map(), 5
    );

    expect(result.imagesAttached).toBe(0);
    expect(result.imagesSkipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(BottleImage.create).not.toHaveBeenCalled();
    expect(bottle.save).not.toHaveBeenCalled(); // no defaultImage to set
  });
});
