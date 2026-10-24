/**
 * Photo changes made in the web app write audit rows, like the same changes
 * made over MCP do.
 *
 * Pins: an upload onto a bottle writes 'image.attach' (via 'web') through the
 * real shared pipeline; linking photos uploaded before the bottle existed
 * writes 'image.link'; restarting background removal writes 'image.retry';
 * a refused request writes nothing.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc, { _id: 'f'.repeat(24), save: jest.fn().mockResolvedValue(this) });
  });
  M.countDocuments = jest.fn();
  M.updateMany = jest.fn();
  M.findById = jest.fn();
  return M;
});
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({}));
jest.mock('../services/imageProcessor', () => ({
  processImage: jest.fn().mockResolvedValue(undefined),
  hashImageBytes: jest.fn(() => 'deadbeef'),
}));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(async () => Buffer.from('CLEAN')),
  detectImageFormat: jest.fn(() => 'jpeg'),
}));
jest.mock('../services/photoFormat', () => ({ encodeKeptPhoto: jest.fn(), KEPT_EXTENSION: 'webp' }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// multer stand-in: the route reads the temp file multer would have written.
jest.mock('../config/upload', () => ({
  upload: { single: () => (req, res, next) => { req.file = { path: '/app/uploads/originals/upload-tmp' }; next(); } },
  ORIGINALS_DIR: '/app/uploads/originals',
}));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => 'owner') }));

const fs = require('fs');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const USER = oid('1');
const BOTTLE = oid('b');
const CELLAR = oid('c');
const IMG = oid('a');

function send(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret');
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        res.on('end', () => { server.close(); resolve({ status: res.statusCode }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const auditActions = () => logAudit.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  getCellarRole.mockReturnValue('owner');
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.updateMany.mockResolvedValue({});
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, cellar: CELLAR, vintage: '2016' });
  Cellar.findById.mockResolvedValue({ _id: CELLAR });
});

describe('POST /api/images/upload', () => {
  const realRead = fs.readFileSync;
  const realUnlink = fs.unlinkSync;
  let spies = [];
  beforeEach(() => {
    spies = [
      jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) =>
        (String(p).endsWith('upload-tmp') ? Buffer.from('RAW') : realRead(p, ...rest))),
      jest.spyOn(fs, 'unlinkSync').mockImplementation((p) =>
        (String(p).endsWith('upload-tmp') ? undefined : realUnlink(p))),
      // The shared pipeline writes the sanitised bytes to a temp name, then renames.
      jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(),
      jest.spyOn(fs.promises, 'rename').mockResolvedValue(),
    ];
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  test('a photo uploaded onto a bottle writes one image.attach row, via the web', async () => {
    const { status } = await send('POST', '/api/images/upload', { bottleId: BOTTLE });
    expect(status).toBe(201);
    expect(auditActions()).toEqual(['image.attach']);
    const [req, , resource, detail] = logAudit.mock.calls[0];
    expect(req.user.id).toBe(USER);
    expect(resource).toEqual({ type: 'bottle', id: BOTTLE, cellarId: CELLAR });
    expect(detail).toEqual({ via: 'web', imageId: oid('f') });
  });

  test('a photo uploaded before its bottle exists writes no attach row (the link does)', async () => {
    const { status } = await send('POST', '/api/images/upload', {});
    expect(status).toBe(201);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/images/link-to-bottle', () => {
  test('linking writes one image.link row on the bottle, with the linked photos', async () => {
    const { status } = await send('POST', '/api/images/link-to-bottle', { bottleId: BOTTLE, imageIds: [oid('e'), oid('d')] });
    expect(status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const [req, action, resource, detail] = logAudit.mock.calls[0];
    expect(req.user.id).toBe(USER);
    expect(action).toBe('image.link');
    expect(resource).toEqual({ type: 'bottle', id: BOTTLE, cellarId: CELLAR });
    expect(detail).toEqual({ imageIds: [oid('e'), oid('d')], via: 'web' });
  });

  test('a viewer is refused and nothing is written', async () => {
    getCellarRole.mockReturnValue('viewer');
    const { status } = await send('POST', '/api/images/link-to-bottle', { bottleId: BOTTLE, imageIds: [oid('e')] });
    expect(status).toBe(403);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/images/:id/retry', () => {
  const image = (over = {}) => ({
    _id: IMG, uploadedBy: USER, kind: 'bottle', status: 'uploaded', bottle: BOTTLE,
    originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null, ...over,
  });

  test('a restarted run writes one image.retry row on the image', async () => {
    BottleImage.findById.mockResolvedValue(image());
    const { status } = await send('POST', `/api/images/${IMG}/retry`);
    expect(status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const [req, action, resource, detail] = logAudit.mock.calls[0];
    expect(req.user.id).toBe(USER);
    expect(action).toBe('image.retry');
    expect(resource).toEqual({ type: 'image', id: IMG });
    expect(detail).toEqual({ bottleId: BOTTLE });
  });

  test('a photo with no bottle yet records a null bottle', async () => {
    BottleImage.findById.mockResolvedValue(image({ bottle: null }));
    await send('POST', `/api/images/${IMG}/retry`);
    expect(logAudit.mock.calls[0][3]).toEqual({ bottleId: null });
  });

  test('a refused retry writes nothing', async () => {
    BottleImage.findById.mockResolvedValue(image({ processedUrl: '/api/uploads/processed/a.webp', status: 'processed' }));
    const { status } = await send('POST', `/api/images/${IMG}/retry`);
    expect(status).toBe(400);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
