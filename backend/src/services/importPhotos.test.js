// services/importPhotos — copying the photos an import file links to onto the
// bottles the import created. Pinned: only allowed links, one photo per link,
// the upload pipeline with no shortcut past the image check, the access and
// duplicate checks at the time the photo is added, one photo at a time, and
// a summary row per import that never carries a link.

jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ exists: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
jest.mock('./imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('./imageProcessor', () => ({ whenProcessingIdle: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { ingestBottleImage } = require('./imageOps');
const { whenProcessingIdle } = require('./imageProcessor');
const { logAudit, logger } = require('./audit');
const {
  queueImportPhotos, stopImportPhotos, whenImportPhotosIdle, resetImportPhotosForTest,
} = require('./importPhotos');

const USER = 'u1';
const CELLAR = 'c1';
const req = { user: { id: USER, roles: ['user'] }, headers: { 'user-agent': 'test' }, ip: '203.0.113.9', body: { items: ['big'] } };
const link = (n) => `https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/wines%2Fu%2Fphoto_${n}?alt=media&token=secret-${n}`;
const bottle = (id, extra = {}) => ({ _id: id, cellar: CELLAR, vintage: '2021', wineDefinition: `w-${id}`, ...extra });

let bottles;
beforeEach(() => {
  jest.clearAllMocks();
  resetImportPhotosForTest();
  bottles = { b1: bottle('b1'), b2: bottle('b2'), b3: bottle('b3') };
  Bottle.findById.mockImplementation(async (id) => bottles[id] || null);
  Cellar.findById.mockReturnValue({ select: () => ({ lean: async () => ({ user: USER, members: [], deletedAt: null }) }) });
  BottleImage.exists.mockResolvedValue(null);
  safeFetchImage.mockResolvedValue({ buffer: Buffer.from('jpeg') });
  ingestBottleImage.mockResolvedValue({ image: { _id: 'img' } });
  whenProcessingIdle.mockResolvedValue();
});

const summary = () => logAudit.mock.calls.filter((c) => c[1] === 'import.photos');

test('one photo per link, on the first bottle that has it; other links are left out', async () => {
  const queued = queueImportPhotos(req, [
    { bottleId: 'b1', url: link(1) },
    { bottleId: 'b2', url: link(1) },
    { bottleId: 'b3', url: 'https://example.com/photo.jpg' },
    { bottleId: 'b3', url: undefined },
  ], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(queued).toBe(1);
  expect(safeFetchImage).toHaveBeenCalledTimes(1);
  expect(safeFetchImage).toHaveBeenCalledWith(link(1));
  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
  expect(ingestBottleImage.mock.calls[0][0].bottle).toBe(bottles.b1);
});

test('the photo goes through the upload pipeline as a member\'s photo, never published by the import', async () => {
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  const [opts, auditReq] = ingestBottleImage.mock.calls[0];
  expect(opts).toMatchObject({
    userId: USER, userRoles: ['user'], bottle: bottles.b1, wineDefinitionId: 'w-b1', keepBackground: false, via: 'import',
  });
  expect(opts.publish).toBeUndefined();
  expect(opts.credit).toBeUndefined();
  // The request is kept as a snapshot: who and from where, not the import's body.
  expect(auditReq).toEqual({ user: req.user, apiToken: undefined, ip: '203.0.113.9', headers: { 'user-agent': 'test' } });
});

test('nothing is added to a bottle that is gone, or in a cellar the member can no longer edit', async () => {
  delete bottles.b1;
  Cellar.findById
    .mockReturnValueOnce({ select: () => ({ lean: async () => ({ user: 'someone', members: [{ user: USER, role: 'viewer' }], deletedAt: null }) }) })
    .mockReturnValueOnce({ select: () => ({ lean: async () => ({ user: USER, members: [], deletedAt: new Date() }) }) });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }, { bottleId: 'b3', url: link(3) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(safeFetchImage).not.toHaveBeenCalled();
  expect(ingestBottleImage).not.toHaveBeenCalled();
  expect(summary()[0][3]).toEqual({ queued: 3, added: 0, notAdded: { bottle_gone: 1, no_access: 2 } });
});

test('a wine and vintage the member already has a photo of gets no second one', async () => {
  BottleImage.exists.mockResolvedValue({ _id: 'old' });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(BottleImage.exists).toHaveBeenCalledWith(expect.objectContaining({
    uploadedBy: USER,
    $or: [{ bottle: 'b1' }, { wineDefinition: 'w-b1', vintage: '2021' }],
  }));
  expect(safeFetchImage).not.toHaveBeenCalled();
  expect(summary()[0][3]).toEqual({ queued: 1, added: 0, notAdded: { already_has_photo: 1 } });
});

test('a failed download or a file that is no image is counted, and the link never reaches the log or the audit', async () => {
  safeFetchImage.mockRejectedValueOnce(new Error('image URL answered HTTP 403'));
  ingestBottleImage.mockResolvedValueOnce({ error: { status: 400, message: 'Image could not be processed' } });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }, { bottleId: 'b3', url: link(3) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(summary()).toHaveLength(1);
  expect(summary()[0][2]).toEqual({ type: 'cellar', id: CELLAR, cellarId: CELLAR });
  expect(summary()[0][3]).toEqual({ queued: 3, added: 1, notAdded: { fetch_failed: 1, not_an_image: 1 } });
  const written = JSON.stringify([logger.warn.mock.calls, logAudit.mock.calls]);
  expect(written).not.toContain('secret-');
  expect(written).not.toContain('firebasestorage');
});

test('one photo at a time: the next waits until background removal is idle', async () => {
  const order = [];
  ingestBottleImage.mockImplementation(async ({ bottle: b }) => { order.push(`add ${b._id}`); return { image: {} }; });
  whenProcessingIdle.mockImplementation(async () => { order.push('idle'); });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(order).toEqual(['add b1', 'idle', 'add b2', 'idle']);
});

test('at shutdown the photo in hand finishes and no further one starts', async () => {
  let release;
  ingestBottleImage.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ image: {} }); }));
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }], { cellarId: CELLAR });
  await new Promise((r) => setImmediate(r));
  const stopped = stopImportPhotos();
  release();
  await stopped;

  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith({ left: 1 }, expect.stringContaining('shutting down'));
  expect(queueImportPhotos(req, [{ bottleId: 'b3', url: link(3) }], { cellarId: CELLAR })).toBe(1);
  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
});
