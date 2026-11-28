// services/importPhotos — copying the photos an import file links to onto the
// bottles the import created. Pinned: only allowed links, one photo per link
// (whatever fragment or spaces it carries), the upload pipeline with the
// background kept and no shortcut past the image check, every redirect held
// to the allowed store, the access and duplicate checks at the time the photo
// is added, imports taking turns one photo each, a daily room per member,
// nothing dropped unseen, and one summary row per import that never carries a
// link — also for an import cut short by a shutdown.

jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ exists: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
jest.mock('./imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { ingestBottleImage } = require('./imageOps');
const { logAudit, logger } = require('./audit');
const {
  queueImportPhotos, stopImportPhotos, whenImportPhotosIdle, resetImportPhotosForTest, DAILY_PHOTOS_PER_USER,
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
});

const summary = () => logAudit.mock.calls.filter((c) => c[1] === 'import.photos');

test('one photo per link, on the first bottle that has it; other links are left out', async () => {
  const answer = queueImportPhotos(req, [
    { bottleId: 'b1', url: link(1) },
    { bottleId: 'b2', url: link(1) },
    { bottleId: 'b3', url: 'https://example.com/photo.jpg' },
    { bottleId: 'b3', url: undefined },
  ], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(answer).toEqual({ queued: 1, notQueued: 0 });
  expect(safeFetchImage).toHaveBeenCalledTimes(1);
  expect(safeFetchImage.mock.calls[0][0]).toBe(link(1));
  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
  expect(ingestBottleImage.mock.calls[0][0].bottle).toBe(bottles.b1);
});

test('a fragment or spaces around a link do not make the same photo a second one', async () => {
  const answer = queueImportPhotos(req, [
    { bottleId: 'b1', url: link(1) },
    { bottleId: 'b2', url: `${link(1)}#1` },
    { bottleId: 'b3', url: `  ${link(1)}#2 ` },
  ], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(answer).toEqual({ queued: 1, notQueued: 0 });
  expect(safeFetchImage).toHaveBeenCalledTimes(1);
  expect(safeFetchImage.mock.calls[0][0]).toBe(link(1));
});

test('every hop of the download is held to the allowed photo store', async () => {
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  const { allowUrl } = safeFetchImage.mock.calls[0][1];
  expect(allowUrl(new URL(link(2)))).toBe(true);
  expect(allowUrl(new URL('https://elsewhere.example/photo.jpg'))).toBe(false);
  expect(allowUrl(new URL('https://firebasestorage.googleapis.com/v0/b/other-app.appspot.com/o/x'))).toBe(false);
});

test('the photo goes through the upload pipeline as the owner took it, never published by the import', async () => {
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  const [opts, auditReq] = ingestBottleImage.mock.calls[0];
  expect(opts).toMatchObject({
    userId: USER, userRoles: ['user'], bottle: bottles.b1, wineDefinitionId: 'w-b1', keepBackground: true, via: 'import',
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

test('a wine and vintage the member already has a photo of gets no second one, a turned-down photo included', async () => {
  BottleImage.exists.mockResolvedValue({ _id: 'old' });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  const query = BottleImage.exists.mock.calls[0][0];
  expect(query).toMatchObject({ uploadedBy: USER, $or: [{ bottle: 'b1' }, { wineDefinition: 'w-b1', vintage: '2021' }] });
  // No status filter: a photo the curator rejected is not sent to them again.
  expect(query).not.toHaveProperty('status');
  expect(safeFetchImage).not.toHaveBeenCalled();
  expect(summary()[0][3]).toEqual({ queued: 1, added: 0, notAdded: { already_has_photo: 1 } });
});

test('a bottle of unknown vintage only checks its own photos, not every unknown-vintage bottle of the wine', async () => {
  bottles.b1 = bottle('b1', { vintage: 'Unknown' });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(BottleImage.exists.mock.calls[0][0].$or).toEqual([{ bottle: 'b1' }]);
  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
});

test('a failed download, a file that is no image and a bottle at its photo cap are counted apart, and the link never reaches the log or the audit', async () => {
  bottles.b4 = bottle('b4');
  safeFetchImage.mockRejectedValueOnce(new Error('image URL answered HTTP 403'));
  ingestBottleImage
    .mockResolvedValueOnce({ error: { status: 400, message: 'Image could not be processed' } })
    .mockResolvedValueOnce({ error: { status: 400, code: 'photo_limit', message: 'Maximum of 20 images per bottle reached' } });
  queueImportPhotos(req, ['b1', 'b2', 'b3', 'b4'].map((b, i) => ({ bottleId: b, url: link(i + 1) })), { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(summary()).toHaveLength(1);
  expect(summary()[0][2]).toEqual({ type: 'cellar', id: CELLAR, cellarId: CELLAR });
  expect(summary()[0][3]).toEqual({ queued: 4, added: 1, notAdded: { fetch_failed: 1, not_an_image: 1, photo_limit: 1 } });
  const written = JSON.stringify([logger.warn.mock.calls, logAudit.mock.calls]);
  expect(written).not.toContain('secret-');
  expect(written).not.toContain('firebasestorage');
});

test('one photo at a time: the next download starts once the previous photo is stored', async () => {
  const order = [];
  safeFetchImage.mockImplementation(async (url) => { order.push(`fetch ${url.slice(-1)}`); return { buffer: Buffer.from('jpeg') }; });
  ingestBottleImage.mockImplementation(async ({ bottle: b }) => {
    order.push(`store ${b._id} start`);
    await new Promise((r) => setImmediate(r));
    order.push(`store ${b._id} done`);
    return { image: {} };
  });
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }], { cellarId: CELLAR });
  await whenImportPhotosIdle();

  expect(order).toEqual(['fetch 1', 'store b1 start', 'store b1 done', 'fetch 2', 'store b2 start', 'store b2 done']);
});

test('imports take turns: a small import is not held back behind a large one', async () => {
  bottles.a1 = bottle('a1'); bottles.a2 = bottle('a2'); bottles.a3 = bottle('a3'); bottles.c1 = bottle('c1');
  const order = [];
  ingestBottleImage.mockImplementation(async ({ bottle: b }) => { order.push(b._id); return { image: {} }; });
  queueImportPhotos(req, ['a1', 'a2', 'a3'].map((b, i) => ({ bottleId: b, url: link(10 + i) })), { cellarId: CELLAR });
  queueImportPhotos({ ...req, user: { id: 'u2', roles: ['user'] } }, [{ bottleId: 'c1', url: link(20) }], { cellarId: 'c2' });
  Cellar.findById.mockReturnValue({ select: () => ({ lean: async () => ({ user: USER, members: [{ user: 'u2', role: 'editor' }], deletedAt: null }) }) });
  await whenImportPhotosIdle();

  // The large import's first photo was already in hand; then they alternate.
  expect(order).toEqual(['a1', 'c1', 'a2', 'a3']);
});

test('a member queues at most a day\'s room; the rest is answered and audited, never dropped unseen', async () => {
  Bottle.findById.mockResolvedValue(null); // nothing to add: this is about counting
  const rows = Array.from({ length: DAILY_PHOTOS_PER_USER + 3 }, (_, i) => ({ bottleId: `x${i}`, url: link(100 + i) }));
  expect(queueImportPhotos(req, rows, { cellarId: CELLAR })).toEqual({ queued: DAILY_PHOTOS_PER_USER, notQueued: 3 });
  await whenImportPhotosIdle();
  expect(summary()[0][3]).toMatchObject({ queued: DAILY_PHOTOS_PER_USER, notQueued: 3 });

  // The same day, a second import has no room left: its row says so at once.
  expect(queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }], { cellarId: CELLAR })).toEqual({ queued: 0, notQueued: 1 });
  expect(summary()[1][3]).toEqual({ queued: 0, added: 0, notQueued: 1 });
  // Another member's room is their own.
  expect(queueImportPhotos({ ...req, user: { id: 'u2', roles: ['user'] } }, [{ bottleId: 'b2', url: link(2) }], { cellarId: CELLAR }))
    .toEqual({ queued: 1, notQueued: 0 });
  await whenImportPhotosIdle();
});

test('at shutdown the photo in hand finishes, no further one starts, and the import cut short gets its summary row', async () => {
  let release;
  ingestBottleImage.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ image: {} }); }));
  queueImportPhotos(req, [{ bottleId: 'b1', url: link(1) }, { bottleId: 'b2', url: link(2) }], { cellarId: CELLAR });
  await new Promise((r) => setImmediate(r));
  const stopped = stopImportPhotos();
  release();
  await stopped;

  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith({ left: 1 }, expect.stringContaining('shutting down'));
  expect(summary()[0][3]).toEqual({ queued: 2, added: 1, notAdded: { not_run: 1 } });
  // A /confirm still answering during the shutdown is told the truth.
  expect(queueImportPhotos(req, [{ bottleId: 'b3', url: link(3) }], { cellarId: CELLAR })).toEqual({ queued: 0, notQueued: 1 });
  expect(ingestBottleImage).toHaveBeenCalledTimes(1);
});
