/**
 * Photos over MCP (support ticket 2026-09-06): the connector could write a
 * photo but never read one back. Pins the read path — get_bottle → photos,
 * has_photo on search_bottles rows, the registry image on get_wine — and the
 * richer attach_bottle_image answer (photos_before, shows_on_bottles, state,
 * the wine_id alternative). The photo-state service itself is unit-tested in
 * services/photoState.test.js; here it is mocked so the TOOL contract is what
 * is pinned.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.distinct = jest.fn(() => Promise.resolve(result));
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn(), find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
// get_wine reads the correction queue for signed-in callers (support ticket
// 2026-09-12) — mocked as "nothing pending" so the real model never buffers.
jest.mock('../models/WineCorrectionProposal', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 900000 }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
// get_photo renders through photoBytes (its own suite pins the downscale);
// imageSource is the real classifier's contract, restated so the external-link
// branch is exercised without loading sharp.
jest.mock('../services/photoBytes', () => ({
  renderImage: jest.fn(),
  imageSource: (ref) => (!ref ? null : /^https?:\/\//i.test(ref) ? { kind: 'external', url: ref } : ref.startsWith('/api/uploads/') ? { kind: 'upload' } : null),
  IMAGE_MAX_EDGE: 1024,
}));
jest.mock('../services/registryReadTracker', () => ({ gateMcpRead: jest.fn().mockResolvedValue({ allowed: true }), CAP_MESSAGE: 'cap' }));
jest.mock('../services/photoState', () => ({
  photosForBottle: jest.fn(),
  photoPresence: jest.fn(),
  absoluteImageUrl: (p) => (p ? `https://api.test/api/uploads/${p}` : null),
  isInlineImage: (p) => typeof p === 'string' && p.startsWith('data:'),
  photoState: (img, uid) => ({
    state: img.status === 'approved' ? 'published' : img.status,
    meaning: 'm',
    mine: img.uploadedBy != null && String(img.uploadedBy) === String(uid),
    credit: img.credit || null,
    registry_image: img.assignedToWine === true,
  }),
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { ingestBottleImage } = require('../services/imageOps');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { photosForBottle, photoPresence } = require('../services/photoState');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const PHOTOS = { count: 1, has_photo: true, mine_pending: 1, registry_image: null, items: [{ image_id: oid('9'), state: 'awaiting_review', mine: true }] };

const ownBottle = (over = {}) => {
  const b = {
    _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')), vintage: '2015', status: 'active',
    wineDefinition: { _id: new mongoose.Types.ObjectId(oid('f')), name: 'Barolo', producer: 'X', grapes: [] }, pours: [], ...over,
  };
  Bottle.findById.mockReturnValue(chain(b));
  Cellar.findById.mockReturnValue(chain({ _id: b.cellar, user: ME, members: [], deletedAt: null, name: 'Mine' }));
  return b;
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('e')) });
  photosForBottle.mockResolvedValue(PHOTOS);
  photoPresence.mockResolvedValue(new Map());
  BottleImage.countDocuments.mockResolvedValue(0);
  Bottle.countDocuments.mockResolvedValue(0);
  ingestBottleImage.mockResolvedValue({ image: { _id: new mongoose.Types.ObjectId(oid('9')), status: 'uploaded' } });
  safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
  Cellar.find.mockReturnValue(chain([{ _id: oid('c') }]));
});

describe('get_bottle → photos', () => {
  test('carries every photo with its state, from the viewer\'s side', async () => {
    ownBottle();
    Rack.findOne.mockReturnValue(chain(null));
    const body = parse(await tool('get_bottle').handler({ bottle_id: oid('d') }, CTX));
    expect(photosForBottle).toHaveBeenCalledWith(ME, expect.objectContaining({ vintage: '2015' }));
    expect(body.data.photos).toEqual(PHOTOS);
  });

  test('a failing photo lookup never takes the bottle down', async () => {
    ownBottle();
    Rack.findOne.mockReturnValue(chain(null));
    photosForBottle.mockRejectedValue(new Error('db down'));
    const body = parse(await tool('get_bottle').handler({ bottle_id: oid('d') }, CTX));
    expect(body.data.wine.name).toBe('Barolo');
    expect(body.data.photos.error).toMatch(/photo lookup failed/);
  });
});

describe('search_bottles → has_photo', () => {
  test('every row carries has_photo from one presence lookup per page', async () => {
    Cellar.find.mockReturnValue(chain([oid('c')]));
    Bottle.countDocuments.mockResolvedValue(2);
    const rows = [
      { _id: oid('1'), cellar: oid('c'), vintage: '2015', status: 'active', wineDefinition: { name: 'A' } },
      { _id: oid('2'), cellar: oid('c'), vintage: '2016', status: 'active', wineDefinition: { name: 'B' } },
    ];
    Bottle.find.mockReturnValue(chain(rows));
    photoPresence.mockResolvedValue(new Map([[oid('1'), true], [oid('2'), false]]));
    const body = parse(await tool('search_bottles').handler({ status: 'active' }, CTX));
    expect(photoPresence).toHaveBeenCalledWith(ME, rows);
    expect(body.data.map((r) => r.has_photo)).toEqual([true, false]);
  });

  test('a failing presence lookup drops the flag with a warning, never the page', async () => {
    Cellar.find.mockReturnValue(chain([oid('c')]));
    Bottle.countDocuments.mockResolvedValue(1);
    Bottle.find.mockReturnValue(chain([{ _id: oid('1'), cellar: oid('c'), vintage: '2015', status: 'active', wineDefinition: { name: 'A' } }]));
    photoPresence.mockRejectedValue(new Error('db down'));
    const body = parse(await tool('search_bottles').handler({ status: 'active' }, CTX));
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('has_photo');
    expect(body.warnings.join(' ')).toMatch(/Photo lookup failed/);
  });
});

describe('get_wine → image', () => {
  const wine = (over) => ({ _id: oid('f'), name: 'Barolo', producer: 'X', slug: 'barolo', grapes: [], ...over });
  test('the registry image comes back as an absolute url with its credit', async () => {
    WineDefinition.findOne.mockReturnValue(chain(wine({ image: 'w.png', imageCredit: 'Estate' })));
    const body = parse(await tool('get_wine').handler({ wine_id: oid('f') }, CTX));
    expect(body.data.image).toEqual({ url: 'https://api.test/api/uploads/w.png', credit: 'Estate' });
  });
  test('no registry image → null, so "no picture yet" is explicit', async () => {
    WineDefinition.findOne.mockReturnValue(chain(wine({})));
    const body = parse(await tool('get_wine').handler({ wine_id: oid('f') }, CTX));
    expect(body.data.image).toBeNull();
  });
});

describe('attach_bottle_image answers with what the user already had and where the photo shows', () => {
  test('photos_before, shows_on_bottles, state and the check hint; a prior photo raises a warning', async () => {
    ownBottle();
    BottleImage.countDocuments.mockResolvedValue(1);
    Bottle.countDocuments.mockResolvedValue(3);
    const body = parse(await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg' }, CTX));
    expect(body.data).toMatchObject({ photos_before: 1, shows_on_bottles: 3, state: 'queued', wine_id: oid('f'), shows_on_all_bottles_of_wine: true });
    expect(body.data.check).toMatch(/get_bottle/);
    expect(body.warnings[0]).toMatch(/already had 1 photo/);
    expect(body.summary).toMatch(/shows on 3 of your bottle\(s\)/);
    // The "already had" count is taken BEFORE the new row exists, by bottle or wine.
    expect(BottleImage.countDocuments.mock.calls[0][0]).toMatchObject({ uploadedBy: ME, status: { $ne: 'rejected' } });
  });

  test('a kept background skips removal: state awaiting_review, no warning when nothing was there', async () => {
    ownBottle();
    ingestBottleImage.mockResolvedValue({ image: { _id: new mongoose.Types.ObjectId(oid('9')), status: 'processed' } });
    const body = parse(await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', keep_background: true }, CTX));
    expect(body.data.state).toBe('awaiting_review');
    expect(body.warnings).toBeUndefined();
  });

  test('wine_id instead of bottle_id lands on the newest active bottle of that wine', async () => {
    ownBottle();
    Bottle.findOne.mockReturnValue(chain({ _id: oid('d') }));
    const body = parse(await tool('attach_bottle_image').handler({ wine_id: oid('f'), image_url: 'https://cdn.example.com/label.jpg' }, CTX));
    expect(body.error).toBeUndefined();
    expect(Bottle.findOne).toHaveBeenCalledWith(expect.objectContaining({ user: ME, wineDefinition: oid('f'), status: 'active', cellar: { $in: [oid('c')] } }));
    expect(body.data.bottle_id).toBe(oid('d'));
  });

  test('wine_id with no bottle of that wine → not_found; neither id → invalid_input', async () => {
    Bottle.findOne.mockReturnValue(chain(null));
    const none = parse(await tool('attach_bottle_image').handler({ wine_id: oid('f'), image_url: 'https://cdn.example.com/label.jpg' }, CTX));
    expect(none.error.code).toBe('not_found');
    const neither = parse(await tool('attach_bottle_image').handler({ image_url: 'https://cdn.example.com/label.jpg' }, CTX));
    expect(neither.error.code).toBe('invalid_input');
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });
});

describe('attach_bottle_image id rules (audit 2026-09-07)', () => {
  test('bottle_id together with wine_id is refused', async () => {
    const body = parse(await tool('attach_bottle_image').handler({ bottle_id: oid('d'), wine_id: oid('f'), image_url: 'https://cdn.example.com/label.jpg' }, CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('wine_id picks only from cellars the user can still edit', async () => {
    ownBottle();
    Bottle.findOne.mockReturnValue(chain({ _id: oid('d') }));
    await tool('attach_bottle_image').handler({ wine_id: oid('f'), image_url: 'https://cdn.example.com/label.jpg' }, CTX);
    expect(Cellar.find.mock.calls[0][0].$or[1]).toEqual({ members: { $elemMatch: { user: ME, role: { $in: ['editor', 'owner'] } } } });
    expect(Bottle.findOne).toHaveBeenCalledWith(expect.objectContaining({ cellar: { $in: [oid('c')] } }));
  });
});

// get_photo (support ticket 2026-09-07): the pixels behind the URLs, under the
// photo-list visibility rule. photoBytes is mocked — its own suite pins the
// downscale; here the TOOL's who-may-see-what and its two-block answer are
// what is pinned.
describe('get_photo', () => {
  const { renderImage } = require('../services/photoBytes');
  const OTHER = oid('b');
  const image = (over = {}) => ({
    _id: new mongoose.Types.ObjectId(oid('9')), uploadedBy: ME, status: 'approved', visibility: 'public', kind: 'bottle',
    originalUrl: '/api/uploads/originals/o.jpg', processedUrl: '/api/uploads/processed/p.png',
    wineDefinition: new mongoose.Types.ObjectId(oid('f')), ...over,
  });
  const ANON = { anonymous: true, user: null, scopes: ['public'], req: { headers: {} } };

  beforeEach(() => {
    renderImage.mockReset();
    renderImage.mockResolvedValue({ data: 'QUJD', mimeType: 'image/jpeg', bytes: 3 });
  });

  test('the owner sees their own photo in any state, as shot (the original): caption first, then the image', async () => {
    BottleImage.findById.mockReturnValue(chain(image({ status: 'rejected', visibility: 'private' })));
    const res = await tool('get_photo').handler({ image_id: oid('9') }, CTX);
    expect(renderImage).toHaveBeenCalledWith('/api/uploads/originals/o.jpg');
    expect(res.content).toHaveLength(2);
    expect(res.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
    const body = parse(res);
    expect(body.summary).toMatch(/Your photo/);
    expect(body.data).toMatchObject({ image_id: oid('9'), kind: 'bottle', mine: true, state: 'rejected', wine_id: oid('f'), bytes: 3, max_edge: 1024 });
  });

  test("another member's photo is visible only once published, and only its published render", async () => {
    BottleImage.findById.mockReturnValue(chain(image({ uploadedBy: OTHER, credit: 'Anna' })));
    const res = await tool('get_photo').handler({ image_id: oid('9') }, CTX);
    expect(renderImage).toHaveBeenCalledWith('/api/uploads/processed/p.png');
    expect(parse(res).summary).toMatch(/gallery photo.*credit: Anna/);
    expect(parse(res).data.mine).toBe(false);

    BottleImage.findById.mockReturnValue(chain(image({ uploadedBy: OTHER, status: 'processed' })));
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX)).error.code).toBe('not_found');
    BottleImage.findById.mockReturnValue(chain(image({ uploadedBy: OTHER, visibility: 'private' })));
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX)).error.code).toBe('not_found');
    BottleImage.findById.mockReturnValue(chain(null));
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX)).error.code).toBe('not_found');
    expect(renderImage).toHaveBeenCalledTimes(1);
  });

  test("the owner's label-scan frame is readable and captioned as a frame; a stranger's never is", async () => {
    BottleImage.findById.mockReturnValue(chain(image({ kind: 'label-scan', side: 'back', status: 'uploaded', visibility: 'private', processedUrl: null })));
    const body = parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX));
    expect(body.summary).toMatch(/BACK label frame/);
    expect(body.data).toMatchObject({ kind: 'label-scan', side: 'back', mine: true, wine_id: oid('f') });
    expect(renderImage).toHaveBeenCalledWith('/api/uploads/originals/o.jpg');

    BottleImage.findById.mockReturnValue(chain(image({ kind: 'label-scan', uploadedBy: OTHER, status: 'approved', visibility: 'public' })));
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX)).error.code).toBe('not_found');
  });

  test('wine_id renders the registry picture; an external link comes back as a url; no picture is explicit', async () => {
    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Barolo', producer: 'X', image: '/api/uploads/processed/w.png', imageCredit: 'Estate' }));
    const res = await tool('get_photo').handler({ wine_id: oid('f') }, CTX);
    expect(renderImage).toHaveBeenCalledWith('/api/uploads/processed/w.png');
    expect(parse(res).summary).toMatch(/registry picture of X — Barolo \(credit: Estate\)/);
    expect(parse(res).data).toMatchObject({ wine_id: oid('f'), kind: 'registry', credit: 'Estate' });
    expect(res.content[1].type).toBe('image');

    renderImage.mockResolvedValue(null);
    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Barolo', image: 'https://cdn.example/w.jpg' }));
    const ext = await tool('get_photo').handler({ wine_id: oid('f') }, CTX);
    expect(ext.content).toHaveLength(1);
    expect(parse(ext).data).toMatchObject({ url: 'https://cdn.example/w.jpg' });

    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Barolo', image: null }));
    expect(parse(await tool('get_photo').handler({ wine_id: oid('f') }, CTX)).data.image).toBeNull();
    WineDefinition.findById.mockReturnValue(chain(null));
    expect(parse(await tool('get_photo').handler({ wine_id: oid('f') }, CTX)).error.code).toBe('not_found');
  });

  test('an unreadable file is unavailable, not a crash; exactly one id; anonymous is refused', async () => {
    BottleImage.findById.mockReturnValue(chain(image()));
    renderImage.mockRejectedValue(new Error('ENOENT'));
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, CTX)).error.code).toBe('unavailable');

    expect(parse(await tool('get_photo').handler({ image_id: oid('9'), wine_id: oid('f') }, CTX)).error.code).toBe('invalid_input');
    expect(parse(await tool('get_photo').handler({}, CTX)).error.code).toBe('invalid_input');
    expect(parse(await tool('get_photo').handler({ image_id: oid('9') }, ANON)).error.code).toBe('forbidden_scope');
  });

  test('get_photo is a read tool, never a public one', () => {
    expect(tool('get_photo').scope).toBe('read');
    expect(tool('get_photo').annotations.readOnlyHint).toBe(true);
  });
});
