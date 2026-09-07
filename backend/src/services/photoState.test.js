/**
 * photoState — the owner-facing photo state behind the MCP read path
 * (support ticket 2026-09-06: no way to tell "no photo", "photo exists" and
 * "upload stuck" apart over the connector). Audit 2026-09-07: own rows and
 * published rows are two bounded queries, own first, so a popular wine can
 * never push the viewer's own row past the cap; inline data: images never
 * travel.
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { photoState, photosForBottle, photoPresence, absoluteImageUrl, isInlineImage, MAX_ROWS } = require('./photoState');

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
  test('full URLs pass through; /api paths and bare filenames get the API base; inline data: never travels', () => {
    expect(absoluteImageUrl('https://x/y.png')).toBe('https://x/y.png');
    expect(absoluteImageUrl('/api/uploads/processed/a.png')).toBe('https://api.test/api/uploads/processed/a.png');
    expect(absoluteImageUrl('a.png')).toBe('https://api.test/api/uploads/a.png');
    expect(absoluteImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(isInlineImage('data:image/png;base64,AAAA')).toBe(true);
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
  test('own rows (any state, rejected included) come from their own bounded query, published rows from another; own first', async () => {
    BottleImage.find
      .mockReturnValueOnce(chain([
        { _id: 'r', status: 'rejected', uploadedBy: ME, processedUrl: null, originalUrl: null, createdAt: 2 },
        { _id: 'q', status: 'uploaded', uploadedBy: ME, originalUrl: '/q.png', wineDefinition: 'w', createdAt: 1 },
      ]))
      .mockReturnValueOnce(chain([
        { _id: 'p', status: 'approved', uploadedBy: OTHER, processedUrl: '/p.png', wineDefinition: 'w', createdAt: 3 },
      ]))
      // The viewer's own label-scan frames: a third bounded query, listed
      // apart from the photos and never counted as one (get_photo reads them).
      .mockReturnValueOnce(chain([{ _id: 's', side: 'back', createdAt: 4 }]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w', image: null } });
    expect(BottleImage.find).toHaveBeenCalledTimes(3);
    expect(BottleImage.find.mock.calls[2][0]).toEqual({ kind: 'label-scan', uploadedBy: ME, wineDefinition: 'w' });
    expect(out.label_scans).toEqual([{ image_id: 's', side: 'back', scanned_at: 4 }]);
    const own = BottleImage.find.mock.calls[0][0];
    expect(own).toMatchObject({ kind: { $ne: 'label-scan' }, uploadedBy: ME });
    expect(own.$or).toEqual([{ bottle: 'b1' }, { wineDefinition: 'w' }]);
    expect(BottleImage.find.mock.calls[1][0]).toEqual({
      kind: { $ne: 'label-scan' }, wineDefinition: 'w', status: 'approved', visibility: 'public', uploadedBy: { $ne: ME },
    });
    expect(out.items.map((i) => i.image_id)).toEqual(['r', 'q', 'p']);
    expect(out).toMatchObject({ count: 3, has_photo: true, mine_pending: 1, registry_image: null });
    expect(out.truncated).toBeUndefined();
  });

  test('a wine with a cap-full gallery cannot hide the viewer\'s own row, and says it was truncated', async () => {
    const many = Array.from({ length: MAX_ROWS }, (_, i) => ({ _id: `p${i}`, status: 'approved', uploadedBy: OTHER, processedUrl: '/p.png', wineDefinition: 'w' }));
    BottleImage.find
      .mockReturnValueOnce(chain([{ _id: 'mine', status: 'uploaded', uploadedBy: ME, originalUrl: '/m.png', wineDefinition: 'w' }]))
      .mockReturnValueOnce(chain(many))
      .mockReturnValueOnce(chain([]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w' } });
    expect(out.items[0].image_id).toBe('mine');
    expect(out.label_scans).toBeUndefined();
    expect(out.mine_pending).toBe(1);
    expect(out.truncated).toBe(true);
  });

  test('a bottle with no registry wine looks up own rows by bottle only and skips the published query', async () => {
    BottleImage.find.mockReturnValueOnce(chain([]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: null });
    expect(BottleImage.find).toHaveBeenCalledTimes(1);
    expect(BottleImage.find.mock.calls[0][0].$or).toEqual([{ bottle: 'b1' }]);
    expect(out).toMatchObject({ count: 0, has_photo: false, mine_pending: 0, items: [] });
  });

  test('the registry image counts as a photo; an inline one is flagged instead of shipped', async () => {
    BottleImage.find.mockReturnValue(chain([]));
    const out = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w', image: 'w.png' } });
    expect(out.has_photo).toBe(true);
    expect(out.registry_image).toBe('https://api.test/api/uploads/w.png');

    BottleImage.find.mockReturnValue(chain([]));
    const inline = await photosForBottle(ME, { _id: 'b1', wineDefinition: { _id: 'w', image: 'data:image/png;base64,AAAA' } });
    expect(inline).toMatchObject({ has_photo: true, registry_image: null, registry_image_inline: true });
  });

  test('only a rejected row → count 1 but no photo', async () => {
    BottleImage.find
      .mockReturnValueOnce(chain([{ _id: 'r', status: 'rejected', uploadedBy: ME, processedUrl: null, originalUrl: null }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));
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
