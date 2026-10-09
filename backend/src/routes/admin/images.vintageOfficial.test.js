/**
 * PUT /api/admin/images/:id/set-vintage-official — "this is THE photo of this
 * wine's <vintage>" (support ticket 2026-10-09).
 *
 * Without a choice a vintage shows the first photo of it approved; this is
 * the override. It promotes any non-rejected photo (approve + publish), takes
 * the vintage from the photo's tag or else its bottle, clears any earlier
 * choice for the same wine + vintage, and never touches the wine's own
 * official image.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/BottleImage', () => ({ findById: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/imageProcessor', () => ({
  unlinkImageFiles: jest.fn(), discardOriginal: jest.fn().mockResolvedValue(undefined), processImage: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const imagesRouter = require('./images');

const IMAGE_ID = '64b0000000000000000000e1';
const WINE_ID = '64b0000000000000000000f1';
const BOTTLE_ID = '64b0000000000000000000b1';

function put(url, roles = ['admin']) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/images', imagesRouter);
  const token = jwt.sign({ id: '64b000000000000000000001', roles }, 'test-secret', { expiresIn: '1h' });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({ port: server.address().port, path: url, method: 'PUT', headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}

const makeImage = (over = {}) => ({
  _id: IMAGE_ID, kind: 'bottle', status: 'processed', visibility: 'private',
  wineDefinition: WINE_ID, bottle: null, vintage: '2016', assignedToWine: false, assignedToVintage: false,
  processedUrl: '/api/uploads/processed/x.webp', originalUrl: null, reviewedBy: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});
const found = (image) => BottleImage.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(image) });
const url = `/api/admin/images/${IMAGE_ID}/set-vintage-official`;

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateMany.mockResolvedValue({});
});

test('promotes the photo for its vintage: clears the earlier choice, approves and publishes, leaves the wine image alone', async () => {
  const image = makeImage();
  found(image);
  const { status, body } = await put(url);

  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, vintage: '2016' });
  expect(BottleImage.updateMany).toHaveBeenCalledWith(
    { wineDefinition: WINE_ID, vintage: '2016', assignedToVintage: true, _id: { $ne: IMAGE_ID } },
    { $set: { assignedToVintage: false } },
  );
  expect(image.assignedToVintage).toBe(true);
  expect(image.status).toBe('approved');
  expect(image.visibility).toBe('public');
  expect(image.assignedToWine).toBe(false);
  expect(image.save).toHaveBeenCalled();
  expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.image.setVintageOfficial', { type: 'image', id: IMAGE_ID }, { wineDefinitionId: WINE_ID, vintage: '2016' });
});

test('a row without its own tag takes its bottle\'s vintage and wine', async () => {
  const image = makeImage({ wineDefinition: null, vintage: null, bottle: { _id: BOTTLE_ID, wineDefinition: WINE_ID, vintage: 'NV' } });
  found(image);
  const { status, body } = await put(url);
  expect(status).toBe(200);
  expect(body.vintage).toBe('NV');
  expect(image.vintage).toBe('NV');
  expect(image.wineDefinition).toBe(WINE_ID);
});

test('refuses a rejected photo, a label scan, a photo of no known vintage, one with no wine — and non-admins', async () => {
  found(makeImage({ status: 'rejected' }));
  expect((await put(url)).status).toBe(400);
  found(makeImage({ kind: 'label-scan' }));
  expect((await put(url)).status).toBe(400);
  found(makeImage({ vintage: 'Unknown' }));
  expect((await put(url)).status).toBe(400);
  found(makeImage({ wineDefinition: null }));
  expect((await put(url)).status).toBe(400);
  expect(BottleImage.updateMany).not.toHaveBeenCalled();

  found(makeImage());
  expect((await put(url, ['user'])).status).toBe(403);
});
