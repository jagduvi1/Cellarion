/**
 * photoState — the owner-facing photo state behind the MCP read path
 * (support ticket 2026-09-06: no way to tell "no photo", "photo exists" and
 * "upload stuck" apart over the connector).
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { photoState, photosForBottle, photoPresence, absoluteImageUrl } = require('./photoState');

const chain = (rows) => {
  const c = {};
  for (const m of ['sort', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(rows));
  return c;
};
const ME = 'u1';
const OTHER = 'u2';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BACKEND_URL = 'https://api.test';
});

describe('absoluteImageUrl', () => {
  test('full URLs pass through; /api paths and bare filenames get the API base', () => {
    expect(absoluteImageUrl('https://x/y.png')).toBe('https://x/y.png');
    expect(absoluteImageUrl('/api/uploads/processed/a.png')).toBe('https://api.test/api/uploads/processed/a.png');
    expect(absoluteImageUrl('a.png')).toBe('https://api.test/api/uploads/a.png');
    expect(absoluteImageUrl(null)).toBeNull();
  });
});

describe('photoState', () => {
  test('maps the storage status to the owner-facing state; who reviewed never travels', () => {
    const out = photoState({
      _id: 'i1', status: 'processed', uploadedBy: ME, processedUrl: '/api/uploads/processed/a.png',
      reviewedBy: 'admin', reviewedAt: null, createdAt: 'c', updatedAt: 'u', wineDefinition: 'w',
    }, ME);
    expect(out).toMatchObject({
      state: 'awaiting_review', mine: true, url: 'https://api.test/api/uploads/processed/a.png',
      shows_on_all_bottles_of_wine: true, reviewed_at: null,
    });
    expect(out.meaning).toMatch(/already shows on your bottles/);
    expect(out).not.toHaveProperty('reviewedBy');
  });

  test('a rejected row reads as rejected with no url; another user\'s row carries no review time', () => {
    expect(photoState({ status: 'rejected', uploadedBy: ME, processedUrl: null, originalUrl: null }, ME))
      .toMatchObject({ state: 'rejected', url: null, mine: true });
    expect(photoState({ status: 'approved', uploadedBy: OTHER, reviewedAt: 'r' }, ME)).not.toHaveProperty('reviewed_at');
  });
});

describe('photosForBottle', () => {
  test('own rows in any state (rejected included) plus other people\'s published rows; own first; counts', async () => {
    BottleImage.find.mockReturnValue(chain([
      { _id: 'p', status: 'approved', uploadedBy: OTHER, processedUrl: '/p.png', wineDefinition: 'w', createdAt: 3 },
      { _id: 'r', status: 'rejected', uploadedBy: ME, processedUrl: null, originalUrl: null, createdAt: 2 },
      { _id: 'q', status: 'uploaded', uploadedBy: ME, originalUrl: '/q.png', wineDefinition: 'w', createdAt: 1 },
    ]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w', image: null } });
    const q = BottleImage.find.mock.calls[0][0];
    expect(q.kind).toEqual({ $ne: 'label-scan' });
    expect(q.$or[0]).toMatchObject({ uploadedBy: ME });
    expect(q.$or[0].$or).toEqual([{ bottle: 'b1' }, { wineDefinition: 'w' }]);
    expect(q.$or[1]).toEqual({ wineDefinition: 'w', status: 'approved', visibility: 'public', uploadedBy: { $ne: ME } });
    expect(out.items.map((i) => i.image_id)).toEqual(['r', 'q', 'p']);
    expect(out).toMatchObject({ count: 3, has_photo: true, mine_pending: 1, registry_image: null });
  });

  test('a bottle with no registry wine looks up by bottle only; nothing found → has_photo false', async () => {
    BottleImage.find.mockReturnValue(chain([]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: null });
    expect(BottleImage.find.mock.calls[0][0].$or).toHaveLength(1);
    expect(out).toMatchObject({ count: 0, has_photo: false, mine_pending: 0, items: [] });
  });

  test('the registry image counts as a photo even with no rows of the viewer\'s own', async () => {
    BottleImage.find.mockReturnValue(chain([]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w', image: 'w.png' } });
    expect(out.has_photo).toBe(true);
    expect(out.registry_image).toBe('https://api.test/api/uploads/w.png');
  });

  test('only a rejected row → count 1 but no photo', async () => {
    BottleImage.find.mockReturnValue(chain([{ _id: 'r', status: 'rejected', uploadedBy: ME, processedUrl: null, originalUrl: null }]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w' } });
    expect(out).toMatchObject({ count: 1, has_photo: false, mine_pending: 0 });
  });
});

describe('photoPresence', () => {
  test('one query per page: own live rows by bottle or wine, published rows by wine, the registry image', async () => {
    BottleImage.find.mockReturnValue(chain([{ bottle: 'b1', wineDefinition: null }, { bottle: null, wineDefinition: 'w2' }]));
    const docs = [
      { _id: 'b1', wineDefinition: { _id: 'w1' } },
      { _id: 'b2', wineDefinition: { _id: 'w2' } },
      { _id: 'b3', wineDefinition: { _id: 'w3', image: 'x.png' } },
      { _id: 'b4', wineDefinition: { _id: 'w4' } },
      { _id: 'b5', wineDefinition: null },
    ];
    const out = await photoPresence(ME, docs);
    expect(BottleImage.find).toHaveBeenCalledTimes(1);
    const q = BottleImage.find.mock.calls[0][0];
    expect(q.$or[0]).toMatchObject({ uploadedBy: ME, status: { $in: ['uploaded', 'processing', 'processed', 'approved'] } });
    expect(q.$or[1]).toEqual({ wineDefinition: { $in: ['w1', 'w2', 'w3', 'w4'] }, status: 'approved', visibility: 'public' });
    expect([...out.entries()]).toEqual([['b1', true], ['b2', true], ['b3', true], ['b4', false], ['b5', false]]);
  });

  test('an empty page makes no query', async () => {
    expect((await photoPresence(ME, [])).size).toBe(0);
    expect(BottleImage.find).not.toHaveBeenCalled();
  });
});
