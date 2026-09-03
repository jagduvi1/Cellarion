/**
 * PUT /api/admin/images/:id/approve — what happens to the ORIGINAL file.
 *
 * Approval used to be the only place a retained original was deleted, with
 * an inline unlink that fired whenever both URLs were set. Since the
 * "keep the background" option (ticket 6a97f870) a row can have
 * processedUrl === originalUrl — the original IS the kept file — and that
 * inline unlink deleted it on approval, leaving processedUrl pointing at
 * nothing. Approval now goes through services/imageProcessor.discardOriginal
 * (real here, with fs mocked): a keepBackground row is left alone; a legacy
 * row that still carries a distinct original has it dropped.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/BottleImage', () => ({
  findById: jest.fn(),
  updateMany: jest.fn(),
  countDocuments: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({}));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/imageProcessor', () => {
  const actual = jest.requireActual('../../services/imageProcessor');
  return { ...actual, unlinkImageFiles: jest.fn() };
});
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(() => true),
  promises: { unlink: jest.fn().mockResolvedValue(undefined), readdir: jest.fn(), stat: jest.fn() },
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const BottleImage = require('../../models/BottleImage');
const imagesRouter = require('./images');

const IMAGE_ID = '64b0000000000000000000e1';
const ORIG = '/api/uploads/originals/abc.jpg';
const PROC = '/api/uploads/processed/abc.png';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/images', imagesRouter);
  return app;
}

function put(app, url) {
  const token = jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret', { expiresIn: '1h' });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({ port: server.address().port, path: url, method: 'PUT', headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}

const makeImage = (overrides = {}) => ({
  _id: IMAGE_ID,
  kind: 'bottle',
  status: 'processed',
  visibility: 'private',
  wineDefinition: null,
  assignedToWine: false,
  keepBackground: false,
  credit: null,
  uploadedBy: '64b000000000000000000002',
  save: jest.fn().mockResolvedValue(undefined),
  populate: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateMany.mockResolvedValue({});
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.updateOne.mockResolvedValue({ acknowledged: true });
});

describe('PUT /api/admin/images/:id/approve and the original file', () => {
  test('a keepBackground row (original IS the kept file) is approved without deleting anything', async () => {
    const image = makeImage({ keepBackground: true, originalUrl: ORIG, processedUrl: ORIG });
    BottleImage.findById.mockResolvedValue(image);

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`);

    expect(status).toBe(200);
    expect(image.status).toBe('approved');
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(image.originalUrl).toBe(ORIG);
    expect(image.processedUrl).toBe(ORIG);
  });

  test('a legacy row still carrying a distinct original has it dropped on approval', async () => {
    const image = makeImage({ originalUrl: ORIG, processedUrl: PROC });
    BottleImage.findById.mockResolvedValue(image);

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`);

    expect(status).toBe(200);
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/originals/abc.jpg');
    expect(BottleImage.updateOne).toHaveBeenCalledWith({ _id: IMAGE_ID, originalUrl: ORIG }, { $set: { originalUrl: null } });
    expect(image.originalUrl).toBeNull();
    expect(image.processedUrl).toBe(PROC);
  });

  test('a label scan is never approvable (it is private curation evidence)', async () => {
    BottleImage.findById.mockResolvedValue(makeImage({ kind: 'label-scan', status: 'uploaded', originalUrl: ORIG, processedUrl: null }));
    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`);
    expect(status).toBe(400);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
  });
});
