/**
 * PUT /api/admin/wine-requests/:id/resolve (createNew) — the image field.
 *
 * Audit 2026-09 F06-1: the request's `image` is chosen by ANY user, and the
 * approval used to store `image || wineRequest.image || null` — so a blanked
 * field silently fell back to the requester's value, and nothing checked its
 * shape. A protocol-relative `//attacker/x` then reached WineDefinition.image,
 * where every viewer's AuthImage fetched it with the bearer token attached.
 * This suite pins: explicit blank ⇒ null; only http(s) / inline / own-upload
 * shapes are stored; a bad value (typed or inherited) is a 400, nothing minted.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineRequest', () => ({ findById: jest.fn() }));
jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../../services/crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null) }));
jest.mock('../../services/producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (p) => p) }));
// The request's photo: decoded for real, stored through the official-picture
// path (mocked here; services/imageOps is tested on its own).
jest.mock('../../services/imageOps', () => ({
  ...jest.requireActual('../../services/imageOps'),
  attachOfficialWineImage: jest.fn(async () => ({ image: { _id: 'img-1', processedUrl: '/api/uploads/originals/img-1.webp' } })),
  // The back label (#1460) goes through the ordinary upload path and is
  // published by the route; the row's save is what the tests inspect.
  ingestBottleImage: jest.fn(async () => ({ image: { _id: 'img-2', status: 'uploaded', visibility: 'private', side: 'front', save: jest.fn(async () => {}) } })),
}));
jest.mock('../../services/imageSanitizer', () => ({
  ...jest.requireActual('../../services/imageSanitizer'),
  sanitizeImageBuffer: jest.fn(async (b) => b),
  // A cut-out unless a test says otherwise (the real check reads the pixels).
  hasTransparency: jest.fn(async () => true),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
const wineRequestsRouter = require('./wineRequests');

const ADMIN_ID = '64b000000000000000000001';
const REQUEST_ID = '64b000000000000000000002';
const COUNTRY_ID = '64b0000000000000000000aa';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wine-requests', wineRequestsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

let requestDoc;
beforeEach(() => {
  jest.clearAllMocks();
  requestDoc = {
    _id: REQUEST_ID,
    status: 'pending',
    requestType: 'new_wine',
    wineName: 'Barolo del Comune',
    user: '64b000000000000000000003',
    image: null,
    save: jest.fn().mockResolvedValue({}),
    populate: jest.fn().mockResolvedValue({}),
  };
  WineRequest.findById.mockResolvedValue(requestDoc);
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
  });
  Country.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Italy' }) }),
  });
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
  Bottle.distinct.mockResolvedValue([]);
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

const resolve = (wineData) => fetch(`${baseUrl}/api/admin/wine-requests/${REQUEST_ID}/resolve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify({
    createNew: true,
    confirmCreate: true,
    adminNotes: '',
    wineData: { name: 'Barolo del Comune', producer: 'Cantina Rossi', country: COUNTRY_ID, type: 'red', ...wineData },
  }),
});

test('an explicitly blank image stores null — it does NOT fall back to the requester\'s value', async () => {
  requestDoc.image = 'https://cdn.example.com/label.png';
  const res = await resolve({ image: '' });
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBeNull();
});

test('an omitted image inherits the request\'s value only when that value is a safe shape', async () => {
  requestDoc.image = '/api/uploads/abc-123.png';
  const res = await resolve({});
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBe('/api/uploads/abc-123.png');
});

test('a protocol-relative value inherited from the request is refused, nothing is minted', async () => {
  requestDoc.image = '//attacker.example/pixel.png';
  const res = await resolve({});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/Wine image/);
  expect(WineDefinition).not.toHaveBeenCalled();
  expect(requestDoc.save).not.toHaveBeenCalled();
});

test('a javascript: or private-host value typed by the admin is refused too', async () => {
  let res = await resolve({ image: 'javascript:alert(1)' });
  expect(res.status).toBe(400);
  res = await resolve({ image: 'http://127.0.0.1/x.png' });
  expect(res.status).toBe(400);
  expect(WineDefinition).not.toHaveBeenCalled();
});

test('a public https link typed by the admin is stored as given', async () => {
  const res = await resolve({ image: 'https://cdn.example.com/bottle.png' });
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBe('https://cdn.example.com/bottle.png');
});

test('approving moves the data version of every owner of a pending bottle — their statistics change', async () => {
  const { getDataVersion } = require('../../services/dataVersion');
  Bottle.distinct.mockImplementation(async (field) => (field === 'user' ? ['owner-a', 'owner-b'] : []));
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 2 });
  const before = [getDataVersion('owner-a'), getDataVersion('owner-b')];
  const res = await resolve({});
  expect(res.status).toBe(200);
  expect(getDataVersion('owner-a')).not.toBe(before[0]);
  expect(getDataVersion('owner-b')).not.toBe(before[1]);
});

// ── A photo attached to the request (inline) — never stored in the wine record ──

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600010100', 'hex').toString('base64');

describe('the photo attached to the request', () => {
  const { attachOfficialWineImage } = require('../../services/imageOps');
  const { sanitizeImageBuffer, hasTransparency } = require('../../services/imageSanitizer');
  const { logAudit } = require('../../services/audit');

  test('kept by the admin: the wine is created without it, then gets it as its official picture file', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ image: '', useRequestPhoto: true });
    expect(res.status).toBe(200);
    expect(WineDefinition.mock.calls[0][0].image).toBeNull();
    expect(attachOfficialWineImage).toHaveBeenCalledTimes(1);
    const [opts] = attachOfficialWineImage.mock.calls[0];
    expect(opts).toMatchObject({ wineDefinitionId: 'wine-new', userId: ADMIN_ID, userRoles: ['admin'], keepBackground: true });
    expect(opts.buffer.equals(Buffer.from(PNG_1PX, 'base64'))).toBe(true);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.wine.image.set', { type: 'wine', id: 'wine-new' },
      { imageId: 'img-1', fromRequest: REQUEST_ID });
  });

  test('an opaque photo (not a cut-out) goes through background removal', async () => {
    requestDoc.image = `data:image/jpeg;base64,${JPEG_BYTES}`;
    hasTransparency.mockResolvedValueOnce(false);
    await resolve({ image: '', useRequestPhoto: true });
    expect(attachOfficialWineImage.mock.calls[0][0].keepBackground).toBe(false);
  });

  test('unticked: approved without it', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ image: '', useRequestPhoto: false });
    expect(res.status).toBe(200);
    expect(WineDefinition.mock.calls[0][0].image).toBeNull();
    expect(attachOfficialWineImage).not.toHaveBeenCalled();
  });

  test('an API caller that leaves the image out gets the photo as a file too, never inline', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({});
    expect(res.status).toBe(200);
    expect(WineDefinition.mock.calls[0][0].image).toBeNull();
    expect(attachOfficialWineImage).toHaveBeenCalledTimes(1);
  });

  test('an API caller that leaves the image out but says useRequestPhoto: false gets no photo', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ useRequestPhoto: false });
    expect(res.status).toBe(200);
    expect(WineDefinition.mock.calls[0][0].image).toBeNull();
    expect(attachOfficialWineImage).not.toHaveBeenCalled();
  });

  test('a link typed by the admin wins over the photo', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ image: 'https://cdn.example.com/bottle.png', useRequestPhoto: true });
    expect(res.status).toBe(200);
    expect(WineDefinition.mock.calls[0][0].image).toBe('https://cdn.example.com/bottle.png');
    expect(attachOfficialWineImage).not.toHaveBeenCalled();
  });

  test('an inline image sent as the wine picture is refused, nothing minted', async () => {
    const res = await resolve({ image: `data:image/png;base64,${PNG_1PX}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Wine image: .*cannot be stored inline/);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('an unreadable photo is refused before anything is created', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    sanitizeImageBuffer.mockRejectedValueOnce(new Error('not an image'));
    const res = await resolve({ image: '', useRequestPhoto: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/photo on the request could not be read/);
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(requestDoc.save).not.toHaveBeenCalled();
  });

  test('when the wine turns out to exist already (same key), its own picture is left alone', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    WineDefinition.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    });
    WineDefinition.findOne.mockResolvedValue({ _id: 'wine-existing', image: '/api/uploads/processed/own.webp' });
    const res = await resolve({ image: '', useRequestPhoto: true });
    expect(res.status).toBe(200);
    expect(attachOfficialWineImage).not.toHaveBeenCalled();
  });

  test('a failed attach does not undo the approval', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    attachOfficialWineImage.mockResolvedValueOnce({ error: { status: 500, message: 'disk full' } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await resolve({ image: '', useRequestPhoto: true });
    expect(res.status).toBe(200);
    expect(requestDoc.save).toHaveBeenCalled();
  });
});

// ── The back label on the request (#1460) — a public gallery photo, never the picture ──

describe('the back label photo on the request', () => {
  const { ingestBottleImage, attachOfficialWineImage } = require('../../services/imageOps');
  const { sanitizeImageBuffer, hasTransparency } = require('../../services/imageSanitizer');
  const { logAudit } = require('../../services/audit');

  test('left ticked (the default): it joins the new wine\'s public photos as the back, not as its picture', async () => {
    requestDoc.backImage = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ image: '' });
    expect(res.status).toBe(200);
    expect(ingestBottleImage).toHaveBeenCalledTimes(1);
    const [opts] = ingestBottleImage.mock.calls[0];
    expect(opts).toMatchObject({ wineDefinitionId: 'wine-new', userId: ADMIN_ID, userRoles: ['admin'], keepBackground: true });
    expect(opts.buffer.equals(Buffer.from(PNG_1PX, 'base64'))).toBe(true);
    const row = (await ingestBottleImage.mock.results[0].value).image;
    expect(row).toMatchObject({ status: 'approved', visibility: 'public', side: 'back', reviewedBy: ADMIN_ID });
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.save).toHaveBeenCalled();
    expect(attachOfficialWineImage).not.toHaveBeenCalled(); // not the wine's picture
    expect(WineDefinition.mock.calls[0][0].image).toBeNull();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.image.approve', { type: 'image', id: 'img-2' },
      { wineDefinitionId: 'wine-new', fromRequest: REQUEST_ID, side: 'back' });
  });

  test('unticked: the back label stays on the request only', async () => {
    requestDoc.backImage = `data:image/png;base64,${PNG_1PX}`;
    const res = await resolve({ image: '', addBackPhoto: false });
    expect(res.status).toBe(200);
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('both photos: the front becomes the picture and the back a gallery photo', async () => {
    requestDoc.image = `data:image/png;base64,${PNG_1PX}`;
    requestDoc.backImage = `data:image/jpeg;base64,${JPEG_BYTES}`;
    const res = await resolve({ image: '', useRequestPhoto: true, addBackPhoto: true });
    expect(res.status).toBe(200);
    expect(attachOfficialWineImage).toHaveBeenCalledTimes(1);
    expect(ingestBottleImage).toHaveBeenCalledTimes(1);
    expect(ingestBottleImage.mock.calls[0][0].buffer.equals(Buffer.from(JPEG_BYTES, 'base64'))).toBe(true);
  });

  test('an opaque back label goes through background removal', async () => {
    requestDoc.backImage = `data:image/jpeg;base64,${JPEG_BYTES}`;
    hasTransparency.mockResolvedValueOnce(false);
    await resolve({ image: '' });
    expect(ingestBottleImage.mock.calls[0][0].keepBackground).toBe(false);
  });

  test('an unreadable back label is refused before anything is created', async () => {
    requestDoc.backImage = `data:image/png;base64,${PNG_1PX}`;
    sanitizeImageBuffer.mockRejectedValueOnce(new Error('corrupt'));
    const res = await resolve({ image: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/back label/i);
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('a back label given as a link is left on the request — nothing is fetched', async () => {
    requestDoc.backImage = 'https://cdn.example.com/back.png';
    const res = await resolve({ image: '' });
    expect(res.status).toBe(200);
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('when the wine turns out to exist already (same key), nothing is added to it', async () => {
    requestDoc.backImage = `data:image/png;base64,${PNG_1PX}`;
    WineDefinition.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    });
    WineDefinition.findOne.mockResolvedValue({ _id: 'wine-existing', image: '/api/uploads/processed/own.webp' });
    const res = await resolve({ image: '' });
    expect(res.status).toBe(200);
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('a failed ingest does not undo the approval', async () => {
    requestDoc.backImage = `data:image/png;base64,${PNG_1PX}`;
    ingestBottleImage.mockResolvedValueOnce({ error: { status: 500, message: 'disk full' } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await resolve({ image: '' });
    expect(res.status).toBe(200);
    expect(requestDoc.save).toHaveBeenCalled();
  });
});
