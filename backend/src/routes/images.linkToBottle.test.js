/**
 * POST /api/images/link-to-bottle — the AddBottle flow uploads photos before
 * the bottle exists, then links them here. Linking now also files each photo
 * under the bottle's vintage (support ticket 2026-10-09), so a photo taken
 * while adding a 2016 is a 2016 photo from the start.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({}));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/upload', () => ({ upload: { single: () => (req, res, next) => next() }, ORIGINALS_DIR: '/app/uploads/originals' }));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => 'owner') }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const USER = oid('1');

function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret');
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: '/api/images/link-to-bottle', method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode }); });
      });
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.updateMany.mockResolvedValue({});
  Cellar.findById.mockResolvedValue({ _id: oid('c') });
});

test('the linked photos take the bottle and its vintage; only the caller\'s own photos are touched', async () => {
  Bottle.findById.mockResolvedValue({ _id: oid('b'), cellar: oid('c'), vintage: '2016' });
  const { status } = await post({ bottleId: oid('b'), imageIds: [oid('e')] });
  expect(status).toBe(200);
  expect(BottleImage.updateMany).toHaveBeenCalledWith(
    { _id: { $in: [oid('e')] }, uploadedBy: USER },
    { bottle: oid('b'), vintage: '2016' },
  );
});

test('a bottle of unknown vintage files its photos wine-wide (null)', async () => {
  Bottle.findById.mockResolvedValue({ _id: oid('b'), cellar: oid('c'), vintage: 'Unknown' });
  await post({ bottleId: oid('b'), imageIds: [oid('e')] });
  expect(BottleImage.updateMany.mock.calls[0][1]).toEqual({ bottle: oid('b'), vintage: null });
});
