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
jest.mock('../../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/imageProcessor', () => {
  const actual = jest.requireActual('../../services/imageProcessor');
  return { ...actual, unlinkImageFiles: jest.fn() };
});
// The real module with the file operations under test stubbed — not a bare
// object: the auth middleware loads the User model, and native bcrypt's loader
// probes the real disk (fs.readdirSync for its prebuilds, and
// existsSync('/etc/alpine-release') to pick musl vs glibc — answering "yes"
// to every path made it load the musl binary on a glibc CI runner).
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn((p) => (String(p).startsWith('/app/uploads') ? true : real.existsSync(p))),
    promises: { unlink: jest.fn().mockResolvedValue(undefined), readdir: jest.fn(), stat: jest.fn() },
  };
});
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const BottleImage = require('../../models/BottleImage');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const imagesRouter = require('./images');

const IMAGE_ID = '64b0000000000000000000e1';
const BOTTLE_ID = '64b0000000000000000000b1';
const WINE_ID = '64b0000000000000000000f1';
const OTHER_WINE_ID = '64b0000000000000000000f2';
const ORIG = '/api/uploads/originals/abc.jpg';
const PROC = '/api/uploads/processed/abc.png';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/images', imagesRouter);
  return app;
}

function put(app, url, body) {
  const token = jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret', { expiresIn: '1h' });
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const headers = {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      };
      const req = http.request({ port: server.address().port, path: url, method: 'PUT', headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end(payload || undefined);
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

/**
 * A photo uploaded on a bottle carries no wine of its own — the bottle does.
 * Publishing it must make it a photo of the wine (every owner of the wine sees
 * it, it can be the wine's picture); until 2026-09-27 the wine reference stayed
 * empty, so a published bottle photo never left its bottle.
 */
describe('a published bottle photo belongs to the wine', () => {
  const bottleWithWine = () => Bottle.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ _id: BOTTLE_ID, wineDefinition: WINE_ID }) }),
  });

  test('approved public, it is linked to its bottle\'s wine — and, the wine having no picture, becomes the registry image', async () => {
    const image = makeImage({ bottle: BOTTLE_ID, processedUrl: PROC, originalUrl: null });
    BottleImage.findById.mockResolvedValue(image);
    bottleWithWine();
    WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Wolfie', producer: 'Piggs Peake', image: null });
    WineDefinition.findByIdAndUpdate.mockResolvedValue({});

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`, { visibility: 'public' });

    expect(status).toBe(200);
    expect(Bottle.findById).toHaveBeenCalledWith(BOTTLE_ID);
    expect(image.wineDefinition).toBe(WINE_ID);
    expect(image.assignedToWine).toBe(true);
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(WINE_ID, { image: PROC, imageCredit: null });
  });

  test('approved public when the wine already has a picture: linked to the wine, not made its picture', async () => {
    const image = makeImage({ bottle: BOTTLE_ID, processedUrl: PROC, originalUrl: null });
    BottleImage.findById.mockResolvedValue(image);
    bottleWithWine();
    WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Wolfie', producer: 'Piggs Peake', image: '/api/uploads/processed/other.webp' });

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`);

    expect(status).toBe(200);
    expect(image.wineDefinition).toBe(WINE_ID);
    expect(image.assignedToWine).toBe(false);
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('approved PRIVATE, it stays the uploader\'s own bottle photo: the wine is not even looked up', async () => {
    const image = makeImage({ bottle: BOTTLE_ID, processedUrl: PROC, originalUrl: null });
    BottleImage.findById.mockResolvedValue(image);
    bottleWithWine();

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`, { visibility: 'private' });

    expect(status).toBe(200);
    expect(Bottle.findById).not.toHaveBeenCalled();
    expect(image.wineDefinition).toBeNull();
    expect(image.assignedToWine).toBe(false);
  });

  test('a photo that already carries a wine (a wine-level upload) keeps it', async () => {
    const image = makeImage({ bottle: BOTTLE_ID, wineDefinition: OTHER_WINE_ID, processedUrl: PROC, originalUrl: null });
    BottleImage.findById.mockResolvedValue(image);
    bottleWithWine();
    WineDefinition.findById.mockResolvedValue({ _id: OTHER_WINE_ID, name: 'x', producer: 'y', image: '/api/uploads/processed/o.webp' });

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/approve`, { visibility: 'public' });

    expect(status).toBe(200);
    expect(Bottle.findById).not.toHaveBeenCalled();
    expect(image.wineDefinition).toBe(OTHER_WINE_ID);
  });

  test('an approved-private bottle photo made public later is linked to the wine then', async () => {
    const image = makeImage({ status: 'approved', visibility: 'private', bottle: BOTTLE_ID, processedUrl: PROC, originalUrl: null });
    BottleImage.findById.mockResolvedValue(image);
    bottleWithWine();

    const { status } = await put(buildApp(), `/api/admin/images/${IMAGE_ID}/visibility`, { visibility: 'public' });

    expect(status).toBe(200);
    expect(image.visibility).toBe('public');
    expect(image.wineDefinition).toBe(WINE_ID);
  });
});
