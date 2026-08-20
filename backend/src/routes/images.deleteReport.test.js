/**
 * DELETE /api/images/:id and POST /api/images/:id/report.
 *
 * Support ticket 6a865f60 (2026-08-20): "How do I remove a picture — the webcam
 * picked up too much to my taste." They could not, and neither could an admin:
 * a photo was only ever deleted as a SIDE EFFECT of deleting the bottle, the
 * cellar or the whole account, and label scans are excluded from the review
 * queue by design (audit L-6). Honouring that request took a script against the
 * database.
 *
 * The line between the two verbs is whether the photo is still ONLY the
 * uploader's. These tests pin that line, because getting it wrong in either
 * direction is bad in a way the user feels: too strict and the person who took
 * the photo cannot remove it; too loose and one user can blank a wine page
 * everybody else reads.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn(), unlinkImageFiles: jest.fn(async () => {}) }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/upload', () => ({ upload: { single: () => (req, res, next) => next() }, ORIGINALS_DIR: '/app/uploads/originals' }));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => null) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { unlinkImageFiles } = require('../services/imageProcessor');
const { logAudit } = require('../services/audit');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const OWNER = oid('1');
const STRANGER = oid('2');
const IMG = oid('a');
const WINE = oid('b');

const tokenFor = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret');

/** A stored image; overrides win. `save` stands in for the Mongoose doc. */
const image = (over = {}) => ({
  _id: IMG,
  uploadedBy: OWNER,
  wineDefinition: null,
  assignedToWine: false,
  visibility: 'private',
  status: 'uploaded',
  kind: 'label-scan',
  side: 'front',
  reports: [],
  reportedAt: null,
  save: jest.fn(async function saved() { return this; }),
  ...over,
});

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  Bottle.updateMany.mockResolvedValue({});
  WineDefinition.updateOne.mockResolvedValue({});
  BottleImage.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

const del = (id, token) => fetch(`${baseUrl}/api/images/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const report = (id, token, body) => fetch(`${baseUrl}/api/images/${id}/report`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('DELETE — the uploader removing their own, still-personal photo', () => {
  test('deletes the row AND the file, and clears every reference first', async () => {
    BottleImage.findById.mockResolvedValue(image({ wineDefinition: WINE }));

    const res = await del(IMG, tokenFor(OWNER));
    expect(res.status).toBe(200);

    // A row removed while its file survives is not a deletion the user asked
    // for — /api/uploads serves bytes by filename with no auth.
    expect(unlinkImageFiles).toHaveBeenCalled();
    expect(BottleImage.deleteOne).toHaveBeenCalledWith({ _id: IMG });
    // Nothing may keep pointing at a photo that no longer exists.
    expect(Bottle.updateMany).toHaveBeenCalledWith({ defaultImage: IMG }, { $set: { defaultImage: null } });
    expect(WineDefinition.updateOne).toHaveBeenCalledWith(
      { _id: WINE, scanImage: IMG }, { $set: { scanImage: null } }
    );
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'image.delete', expect.anything(), expect.anything());
  });

  test('a stranger gets 404, not 403 — the id is not confirmed to exist', async () => {
    BottleImage.findById.mockResolvedValue(image());
    const res = await del(IMG, tokenFor(STRANGER));
    expect(res.status).toBe(404);
    expect(BottleImage.deleteOne).not.toHaveBeenCalled();
    expect(unlinkImageFiles).not.toHaveBeenCalled();
  });

  test('refuses once the photo is the wine\'s picture, and says to report instead', async () => {
    BottleImage.findById.mockResolvedValue(image({ assignedToWine: true, wineDefinition: WINE, visibility: 'public', status: 'approved' }));
    const res = await del(IMG, tokenFor(OWNER));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('assigned_to_wine');
    expect(body.error).toMatch(/report it instead/i);
    expect(BottleImage.deleteOne).not.toHaveBeenCalled();
  });

  test('a still-personal photo deletes even when it is public but unassigned', async () => {
    // visibility alone does not make it registry content; assignment does.
    BottleImage.findById.mockResolvedValue(image({ visibility: 'public', status: 'approved', kind: 'bottle' }));
    const res = await del(IMG, tokenFor(OWNER));
    expect(res.status).toBe(200);
    expect(BottleImage.deleteOne).toHaveBeenCalled();
  });

  test('a missing image is 404 and touches nothing', async () => {
    BottleImage.findById.mockResolvedValue(null);
    expect((await del(IMG, tokenFor(OWNER))).status).toBe(404);
    expect(unlinkImageFiles).not.toHaveBeenCalled();
  });
});

describe('REPORT — raising it for an admin instead of deleting', () => {
  test('records the reporter, the reason, and stamps reportedAt once', async () => {
    const img = image({ assignedToWine: true, visibility: 'public', status: 'approved', uploadedBy: STRANGER });
    BottleImage.findById.mockResolvedValue(img);

    const res = await report(IMG, tokenFor(OWNER), { reason: 'private-info', detail: 'my kitchen is in it' });
    expect(res.status).toBe(200);
    expect(img.reports).toHaveLength(1);
    expect(img.reports[0]).toMatchObject({ user: OWNER, reason: 'private-info', detail: 'my kitchen is in it' });
    expect(img.reportedAt).toBeInstanceOf(Date);
    expect(img.save).toHaveBeenCalled();
  });

  test('an unknown reason is refused', async () => {
    BottleImage.findById.mockResolvedValue(image({ visibility: 'public', status: 'approved' }));
    const res = await report(IMG, tokenFor(OWNER), { reason: 'because-i-said-so' });
    expect(res.status).toBe(400);
  });

  test('a private photo belonging to someone else is 404 — you cannot report what you cannot see', async () => {
    BottleImage.findById.mockResolvedValue(image({ uploadedBy: STRANGER, visibility: 'private', status: 'uploaded' }));
    const res = await report(IMG, tokenFor(OWNER), { reason: 'offensive' });
    expect(res.status).toBe(404);
  });

  test('the same person cannot report twice', async () => {
    const img = image({
      visibility: 'public', status: 'approved', uploadedBy: STRANGER,
      reports: [{ user: OWNER, reason: 'offensive', createdAt: new Date() }],
      reportedAt: new Date(),
    });
    BottleImage.findById.mockResolvedValue(img);
    const res = await report(IMG, tokenFor(OWNER), { reason: 'other' });
    expect(res.status).toBe(409);
    expect(img.reports).toHaveLength(1);
  });

  test('the uploader may report their OWN photo — the withdrawal path once it is assigned', async () => {
    const img = image({ assignedToWine: true, visibility: 'public', status: 'approved' });
    BottleImage.findById.mockResolvedValue(img);
    const res = await report(IMG, tokenFor(OWNER), { reason: 'private-info' });
    expect(res.status).toBe(200);
    expect(img.reports[0].user).toBe(OWNER);
  });

  test('detail is stripped and bounded rather than trusted', async () => {
    const img = image({ visibility: 'public', status: 'approved', uploadedBy: STRANGER });
    BottleImage.findById.mockResolvedValue(img);
    await report(IMG, tokenFor(OWNER), { reason: 'other', detail: '<script>alert(1)</script>x'.padEnd(900, 'y') });
    expect(img.reports[0].detail).not.toMatch(/<script>/);
    expect(img.reports[0].detail.length).toBeLessThanOrEqual(500);
  });
});
