/**
 * Visibility tests for PUT /api/admin/images/:id/assign-to-wine (security
 * audit 2026-07-08, L-7).
 *
 * WHY THIS TEST EXISTS:
 * assign-to-wine used to set WineDefinition.image without touching
 * image.visibility, so an approved-but-PRIVATE image could become the public
 * wine detail / og:image while GET /api/images/wine/:id still hid it. The fix
 * mirrors the sibling set-official route: publishing an image to the public
 * wine page implicitly makes it public, so assign-to-wine now flips
 * visibility to 'public' before saving. The status:'approved' gate is kept.
 *
 * The real admin images router is mounted with the real
 * requireAuth + requireRole('admin') middleware (HS256 test tokens); models
 * and services are mocked so no MongoDB / Meilisearch / sharp is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/BottleImage', () => ({
  findById: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../../models/WineDefinition', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({}));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/imageProcessor', () => ({
  reprocessAllImages: jest.fn(),
  safeUploadPath: jest.fn(),
  unlinkImageFiles: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const imagesRouter = require('./images');

const IMAGE_ID = '64b0000000000000000000e1';
const WINE_ID = '64b0000000000000000000f1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/images', imagesRouter);
  return app;
}

function makeReq(app, method, url, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ port, path: url, method, headers }, (res) => {
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

const adminToken = () =>
  jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret', {
    algorithm: 'HS256',
    expiresIn: '1h',
  });

const makeImage = (overrides = {}) => ({
  _id: IMAGE_ID,
  status: 'approved',
  visibility: 'private',
  wineDefinition: WINE_ID,
  assignedToWine: false,
  processedUrl: '/api/uploads/abc.png',
  originalUrl: null,
  credit: null,
  uploadedBy: '64b000000000000000000002',
  save: jest.fn().mockResolvedValue(undefined),
  populate: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateMany.mockResolvedValue({});
  WineDefinition.findByIdAndUpdate.mockResolvedValue({});
});

describe('PUT /api/admin/images/:id/assign-to-wine visibility (L-7)', () => {
  test('assigning an approved-but-PRIVATE image flips it to public before saving', async () => {
    const image = makeImage({ visibility: 'private' });
    BottleImage.findById.mockResolvedValue(image);

    const { status } = await makeReq(buildApp(), 'PUT', `/api/admin/images/${IMAGE_ID}/assign-to-wine`, {
      authorization: `Bearer ${adminToken()}`,
    });

    expect(status).toBe(200);
    expect(image.visibility).toBe('public');
    expect(image.assignedToWine).toBe(true);
    expect(image.save).toHaveBeenCalled();
    // the save carrying visibility='public' happens BEFORE the wine page starts
    // serving the URL
    expect(image.save.mock.invocationCallOrder[0])
      .toBeLessThan(WineDefinition.findByIdAndUpdate.mock.invocationCallOrder[0]);
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(
      WINE_ID,
      { image: '/api/uploads/abc.png', imageCredit: null }
    );
  });

  test('an already-public image stays public and still assigns', async () => {
    const image = makeImage({ visibility: 'public' });
    BottleImage.findById.mockResolvedValue(image);

    const { status } = await makeReq(buildApp(), 'PUT', `/api/admin/images/${IMAGE_ID}/assign-to-wine`, {
      authorization: `Bearer ${adminToken()}`,
    });

    expect(status).toBe(200);
    expect(image.visibility).toBe('public');
    expect(image.assignedToWine).toBe(true);
  });

  test('the status gate is kept: a non-approved image is rejected with 400 and left untouched', async () => {
    const image = makeImage({ status: 'processed', visibility: 'private' });
    BottleImage.findById.mockResolvedValue(image);

    const { status, body } = await makeReq(buildApp(), 'PUT', `/api/admin/images/${IMAGE_ID}/assign-to-wine`, {
      authorization: `Bearer ${adminToken()}`,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/approved/i);
    expect(image.visibility).toBe('private');
    expect(image.save).not.toHaveBeenCalled();
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('route stays admin-only: a regular user gets 403', async () => {
    const userToken = jwt.sign(
      { id: '64b000000000000000000003', roles: ['user'] },
      'test-secret',
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const { status } = await makeReq(buildApp(), 'PUT', `/api/admin/images/${IMAGE_ID}/assign-to-wine`, {
      authorization: `Bearer ${userToken}`,
    });
    expect(status).toBe(403);
    expect(BottleImage.findById).not.toHaveBeenCalled();
  });
});
