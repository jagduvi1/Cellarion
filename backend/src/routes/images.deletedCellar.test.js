/**
 * The photo routes that load a bottle's cellar themselves (upload, bottle
 * gallery, link-to-bottle, single image) follow the same access rule as
 * middleware/bottleAccess and the MCP tools: a soft-deleted cellar is treated
 * as missing, so its bottles' photos answer 404 until the cellar is restored or
 * purged; a caller with no role on the cellar gets the same 404 (the bottle's
 * existence is not confirmed); a viewer asking to write keeps the 403.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), updateMany: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// multer stand-in: every upload lands a real temp file in a private originals
// directory, so the tests can see whether the route removed it.
jest.mock('../config/upload', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cellarion-images-'));
  let n = 0;
  return {
    ORIGINALS_DIR: dir,
    upload: {
      single: () => (req, res, next) => {
        n += 1;
        const file = path.join(dir, `upload-${n}.jpg`);
        fs.writeFileSync(file, 'image bytes');
        req.file = { path: file };
        next();
      },
    },
  };
});
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => 'owner') }));

const fs = require('fs');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { ingestBottleImage } = require('../services/imageOps');
const { logAudit } = require('../services/audit');
const { ORIGINALS_DIR } = require('../config/upload');
const { getCellarRole } = require('../utils/cellarAccess');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const USER = oid('1');
const OWNER = oid('2');
const BOTTLE = oid('b');
const CELLAR = oid('c');
const IMG = oid('e');

const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret');

/** Chainable thenable standing in for a Mongoose Query. */
const makeQuery = (rows = []) => {
  const q = {
    sort: jest.fn(() => q),
    select: jest.fn(() => q),
    limit: jest.fn(() => q),
    lean: jest.fn(() => q),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
};

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  fs.rmSync(ORIGINALS_DIR, { recursive: true, force: true });
  server.closeAllConnections();
  server.close(done);
});

const liveCellar = () => ({ _id: CELLAR, user: OWNER, deletedAt: null });
const deletedCellar = () => ({ _id: CELLAR, user: OWNER, deletedAt: new Date('2026-10-20T00:00:00Z') });

beforeEach(() => {
  jest.clearAllMocks();
  for (const f of fs.readdirSync(ORIGINALS_DIR)) fs.rmSync(`${ORIGINALS_DIR}/${f}`);
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, user: OWNER, cellar: CELLAR, wineDefinition: null, vintage: '2016', defaultImage: null });
  Cellar.findById.mockResolvedValue(liveCellar());
  getCellarRole.mockReturnValue('owner');
  BottleImage.find.mockReturnValue(makeQuery([]));
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.updateMany.mockResolvedValue({});
  BottleImage.distinct.mockImplementation(async (field, filter) => filter._id.$in);
  ingestBottleImage.mockResolvedValue({ image: { _id: IMG } });
});

const send = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const tempFilesLeft = () => fs.readdirSync(ORIGINALS_DIR).length;

describe('POST /api/images/upload with a bottleId', () => {
  const upload = () => send('POST', '/api/images/upload', { bottleId: BOTTLE });

  test('a bottle in a deleted cellar is not found, and the temp file is removed', async () => {
    Cellar.findById.mockResolvedValue(deletedCellar());
    const { status, body } = await upload();
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(ingestBottleImage).not.toHaveBeenCalled();
    expect(tempFilesLeft()).toBe(0);
  });

  test('a bottle whose cellar is gone is not found', async () => {
    Cellar.findById.mockResolvedValue(null);
    const { status, body } = await upload();
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(tempFilesLeft()).toBe(0);
  });

  test('a caller with no role on the cellar gets 404, not 403', async () => {
    getCellarRole.mockReturnValue(null);
    const { status, body } = await upload();
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(ingestBottleImage).not.toHaveBeenCalled();
    expect(tempFilesLeft()).toBe(0);
  });

  test('a viewer is refused with 403', async () => {
    getCellarRole.mockReturnValue('viewer');
    const { status, body } = await upload();
    expect(status).toBe(403);
    expect(body.error).toBe('Not authorized to upload images for this bottle');
    expect(ingestBottleImage).not.toHaveBeenCalled();
    expect(tempFilesLeft()).toBe(0);
  });

  test('an editor of a live cellar uploads', async () => {
    getCellarRole.mockReturnValue('editor');
    const { status } = await upload();
    expect(status).toBe(201);
    expect(ingestBottleImage).toHaveBeenCalledTimes(1);
    expect(tempFilesLeft()).toBe(0);
  });
});

describe('GET /api/images/bottle/:bottleId', () => {
  test('a bottle in a deleted cellar is not found, even for the cellar owner', async () => {
    Cellar.findById.mockResolvedValue(deletedCellar());
    const { status, body } = await send('GET', `/api/images/bottle/${BOTTLE}`);
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(BottleImage.find).not.toHaveBeenCalled();
  });

  test('the owner of a live cellar reads the gallery', async () => {
    const { status } = await send('GET', `/api/images/bottle/${BOTTLE}`);
    expect(status).toBe(200);
  });
});

describe('POST /api/images/link-to-bottle', () => {
  const link = () => send('POST', '/api/images/link-to-bottle', { bottleId: BOTTLE, imageIds: [IMG] });

  test('a bottle in a deleted cellar is not found and nothing is linked', async () => {
    Cellar.findById.mockResolvedValue(deletedCellar());
    const { status, body } = await link();
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a caller with no role on the cellar gets 404, not 403', async () => {
    getCellarRole.mockReturnValue(null);
    const { status, body } = await link();
    expect(status).toBe(404);
    expect(body.error).toBe('Bottle not found');
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });

  test('a viewer is refused with 403', async () => {
    getCellarRole.mockReturnValue('viewer');
    const { status, body } = await link();
    expect(status).toBe(403);
    expect(body.error).toBe('Not authorized to link images to this bottle');
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });

  test('an editor of a live cellar links', async () => {
    getCellarRole.mockReturnValue('editor');
    const { status } = await link();
    expect(status).toBe(200);
    expect(BottleImage.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/images/:id', () => {
  // Someone else's private photo on a bottle in a cellar the caller is a member of.
  const memberPhoto = (over = {}) => ({
    _id: IMG, uploadedBy: OWNER, bottle: BOTTLE, kind: 'bottle',
    status: 'approved', visibility: 'private', processedUrl: '/api/uploads/a.webp', ...over,
  });

  test('a member of a deleted cellar is refused', async () => {
    BottleImage.findById.mockResolvedValue(memberPhoto());
    Cellar.findById.mockResolvedValue(deletedCellar());
    getCellarRole.mockReturnValue('viewer');
    const { status, body } = await send('GET', `/api/images/${IMG}`);
    expect(status).toBe(404);
    expect(body.error).toBe('Image not found');
  });

  test('a member of a live cellar reads it', async () => {
    BottleImage.findById.mockResolvedValue(memberPhoto());
    getCellarRole.mockReturnValue('viewer');
    const { status, body } = await send('GET', `/api/images/${IMG}`);
    expect(status).toBe(200);
    expect(body.image._id).toBe(IMG);
  });

  test('the uploader still reads their own photo in a deleted cellar', async () => {
    BottleImage.findById.mockResolvedValue(memberPhoto({ uploadedBy: USER }));
    Cellar.findById.mockResolvedValue(deletedCellar());
    getCellarRole.mockReturnValue(null);
    const { status } = await send('GET', `/api/images/${IMG}`);
    expect(status).toBe(200);
  });
});
