/**
 * POST /api/images/:id/retry — who and what may be re-run through rembg
 * (post-ship audit 2026-09-03).
 *
 *  - Never a label scan: it is curation evidence kept as received, and since
 *    originals are discarded after rembg, a retry would delete the frame the
 *    curator needs.
 *  - An image an admin approved before rembg got to it ('approved', no
 *    processedUrl) IS retryable — with the reprocess-all job gone it would
 *    otherwise be stuck with the raw frame for good.
 *  - An image that already has a processed file is not.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/upload', () => ({ upload: { single: () => (req, res, next) => next() }, ORIGINALS_DIR: '/app/uploads/originals' }));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => null) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const { processImage } = require('../services/imageProcessor');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const IMG = oid('a');
const USER = oid('1');
const OTHER = oid('2');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/images', imagesRouter);
  return a;
}

function post(a, path, userId = USER) {
  const token = jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', { expiresIn: '1h' });
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method: 'POST', headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const image = (over = {}) => ({
  _id: IMG, uploadedBy: USER, kind: 'bottle', status: 'uploaded',
  originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null, keepBackground: false,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('POST /api/images/:id/retry', () => {
  test('a failed upload is re-run', async () => {
    BottleImage.findById.mockResolvedValue(image());
    const { status } = await post(app(), `/api/images/${IMG}/retry`);
    expect(status).toBe(200);
    expect(processImage).toHaveBeenCalledWith(IMG);
  });

  test('an image approved before it was processed is re-run too', async () => {
    BottleImage.findById.mockResolvedValue(image({ status: 'approved' }));
    const { status } = await post(app(), `/api/images/${IMG}/retry`);
    expect(status).toBe(200);
    expect(processImage).toHaveBeenCalledWith(IMG);
  });

  test('a label scan is never re-run, whatever its state', async () => {
    BottleImage.findById.mockResolvedValue(image({ kind: 'label-scan' }));
    const { status } = await post(app(), `/api/images/${IMG}/retry`);
    expect(status).toBe(400);
    expect(processImage).not.toHaveBeenCalled();
  });

  test('an image that already has a processed file, or belongs to someone else, is refused', async () => {
    BottleImage.findById.mockResolvedValue(image({ status: 'processed', processedUrl: '/api/uploads/processed/a.png' }));
    expect((await post(app(), `/api/images/${IMG}/retry`)).status).toBe(400);

    BottleImage.findById.mockResolvedValue(image());
    expect((await post(app(), `/api/images/${IMG}/retry`, OTHER)).status).toBe(403);
    expect(processImage).not.toHaveBeenCalled();
  });
});
