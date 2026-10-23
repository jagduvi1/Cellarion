/**
 * DELETE /api/admin/images/:id — the wine's official picture never points at
 * a deleted file.
 *
 * A record can carry two files (the original upload and the processed one),
 * and unlinkImageFiles removes both. The hand-over compared wine.image with
 * the preferred URL only (processedUrl || originalUrl), so a wine whose
 * picture sat on the record's originalUrl while a processed file existed kept
 * pointing at a file that was then deleted — a broken registry picture for
 * every viewer. The real admin images router is mounted with the real auth
 * middleware; models and services are mocked (style of images.assign.test.js).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/BottleImage', () => ({
  findById: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ findById: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/imageProcessor', () => ({
  unlinkImageFiles: jest.fn(),
  discardOriginal: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../../models/BottleImage');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { unlinkImageFiles } = require('../../services/imageProcessor');
const imagesRouter = require('./images');

const IMAGE_ID = '64b0000000000000000000e1';
const SURVIVOR_ID = '64b0000000000000000000e2';
const WINE_ID = '64b0000000000000000000f1';
const ORIGINAL = '/api/uploads/original-abc.jpg';
const PROCESSED = '/api/uploads/processed-abc.webp';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/images', imagesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const adminToken = () => jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
const del = () => fetch(`${baseUrl}/api/admin/images/${IMAGE_ID}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken()}` } });

const makeImage = (over = {}) => ({
  _id: IMAGE_ID,
  wineDefinition: WINE_ID,
  assignedToWine: true,
  processedUrl: PROCESSED,
  originalUrl: ORIGINAL,
  contentHash: null,
  uploadedBy: '64b000000000000000000002',
  deleteOne: jest.fn().mockResolvedValue(undefined),
  ...over,
});
const makeWine = (image) => {
  const wine = { _id: WINE_ID, image, imageCredit: 'Photo: someone' };
  wine.save = jest.fn().mockResolvedValue(wine);
  return wine;
};
// The byte-identical survivor lookup: BottleImage.find(...).sort(...).lean()
const survivors = (list) => BottleImage.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(list) }) });

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.updateMany.mockResolvedValue({});
  BottleImage.updateOne.mockResolvedValue({});
  survivors([]);
});

test('wine.image on the record\'s originalUrl (a processed file exists) is cleared before the files go', async () => {
  BottleImage.findById.mockResolvedValue(makeImage());
  const wine = makeWine(ORIGINAL);
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await del();
  expect(res.status).toBe(200);
  expect(wine.image).toBeNull();
  expect(wine.imageCredit).toBeNull();
  expect(wine.save).toHaveBeenCalled();
  expect(searchService.indexWine).toHaveBeenCalledWith(WINE_ID);
  expect(unlinkImageFiles).toHaveBeenCalled();
});

test('wine.image on the record\'s originalUrl is handed to a byte-identical survivor', async () => {
  BottleImage.findById.mockResolvedValue(makeImage({ contentHash: 'h1' }));
  survivors([{ _id: SURVIVOR_ID, uploadedBy: '64b000000000000000000002', processedUrl: '/api/uploads/survivor.webp', originalUrl: null, credit: 'Photo: survivor' }]);
  const wine = makeWine(ORIGINAL);
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await del();
  expect(res.status).toBe(200);
  expect(wine.image).toBe('/api/uploads/survivor.webp');
  expect(wine.imageCredit).toBe('Photo: survivor');
  expect(BottleImage.updateOne).toHaveBeenCalledWith(
    { _id: SURVIVOR_ID },
    { $set: { wineDefinition: WINE_ID, assignedToWine: true, status: 'approved', visibility: 'public' } }
  );
  expect(wine.save).toHaveBeenCalled();
});

test('wine.image on the processedUrl: cleared exactly as before (regression guard)', async () => {
  BottleImage.findById.mockResolvedValue(makeImage());
  const wine = makeWine(PROCESSED);
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await del();
  expect(res.status).toBe(200);
  expect(wine.image).toBeNull();
  expect(wine.save).toHaveBeenCalled();
});

test('wine.image pointing at some other picture: the wine is left alone', async () => {
  BottleImage.findById.mockResolvedValue(makeImage());
  const wine = makeWine('/api/uploads/someone-elses.webp');
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await del();
  expect(res.status).toBe(200);
  expect(wine.image).toBe('/api/uploads/someone-elses.webp');
  expect(wine.save).not.toHaveBeenCalled();
  expect(searchService.indexWine).not.toHaveBeenCalled();
});
