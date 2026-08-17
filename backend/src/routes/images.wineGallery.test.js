/**
 * GET /api/images/wine/:wineDefinitionId — the filter, pinned.
 *
 * This endpoint used to be reached only from admin pages and a bottle's own
 * detail view. It is now mounted on AddBottle, so every user adding a bottle
 * queries it for a wine they may have nothing to do with. Nothing tested the
 * filter before, which is uncomfortable for a query whose only job is to decide
 * what a stranger may see.
 *
 * Two things it must never do, both load-bearing:
 *
 *  - Return a label scan. Those are the raw frames handed to the AI scanner —
 *    private curation evidence that DOES carry a wineDefinition, so it sits
 *    inside this query's candidate set. /api/uploads serves bytes by
 *    unguessable filename with no auth, so a scan surfaced here would be
 *    permanently and anonymously fetchable with no way to re-gate it.
 *  - Ship uploader identity. `uploadedBy` joins to a name via
 *    GET /api/users/public/:id, which would attribute every registry photo to
 *    a named account for anyone browsing a wine.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/upload', () => ({ upload: { single: () => (req, res, next) => next() }, ORIGINALS_DIR: '/app/uploads/originals' }));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => null) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const WINE = oid('a');
const USER = oid('1');
const ADMIN = oid('2');

const tokenFor = (id, roles) => jwt.sign({ id, roles }, 'test-secret');

/** Chainable thenable standing in for a Mongoose Query. */
const makeQuery = (rows = []) => {
  const q = {
    sort: jest.fn(() => q),
    select: jest.fn(() => q),
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
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => jest.clearAllMocks());

const get = (path, token) =>
  fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

/** The filter object the route handed to BottleImage.find. */
const filterUsed = () => BottleImage.find.mock.calls[0][0];

describe('what an ordinary user may see', () => {
  test('approved + public only, and never a label scan', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    const res = await get(`/api/images/wine/${WINE}`, tokenFor(USER, ['user']));
    expect(res.status).toBe(200);

    const f = filterUsed();
    expect(f.wineDefinition).toBe(WINE);
    expect(f.status).toBe('approved');
    expect(f.visibility).toBe('public');
    // Excluded by name, not merely by relying on status/visibility.
    expect(f.kind).toEqual({ $ne: 'label-scan' });
  });

  test('uploader identity never leaves the server', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    await get(`/api/images/wine/${WINE}`, tokenFor(USER, ['user']));

    expect(q.select).toHaveBeenCalledTimes(1);
    const fields = q.select.mock.calls[0][0];
    for (const leaky of ['uploadedBy', 'reviewedBy', 'contentHash', 'bottle']) {
      expect(fields).not.toContain(leaky);
    }
    // …while still carrying what the gallery actually renders.
    for (const needed of ['processedUrl', 'credit', 'assignedToWine']) {
      expect(fields).toContain(needed);
    }
  });

  test('?all=true from a non-admin does not widen anything', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    await get(`/api/images/wine/${WINE}?all=true`, tokenFor(USER, ['user']));

    const f = filterUsed();
    expect(f.status).toBe('approved');
    expect(f.visibility).toBe('public');
    expect(q.select).toHaveBeenCalledTimes(1); // still projected
  });

  test('a sommelier is not an admin here either', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    await get(`/api/images/wine/${WINE}?all=true`, tokenFor(USER, ['sommelier']));

    expect(filterUsed().visibility).toBe('public');
  });
});

describe('the admin branch', () => {
  test('sees unapproved and private rows — but still no label scans', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    const res = await get(`/api/images/wine/${WINE}?all=true`, tokenFor(ADMIN, ['admin']));
    expect(res.status).toBe(200);

    const f = filterUsed();
    expect(f.status).toEqual({ $ne: 'rejected' });
    expect(f.visibility).toBeUndefined();
    expect(f.kind).toEqual({ $ne: 'label-scan' });
    // Admin surfaces need the full row (duplicate detection reads contentHash).
    expect(q.select).not.toHaveBeenCalled();
  });

  test('an admin WITHOUT all=true gets the same narrow view as anyone else', async () => {
    const q = makeQuery([]);
    BottleImage.find.mockReturnValue(q);

    await get(`/api/images/wine/${WINE}`, tokenFor(ADMIN, ['admin']));

    expect(filterUsed().status).toBe('approved');
    expect(q.select).toHaveBeenCalledTimes(1);
  });
});

test('a bad id is rejected before any query runs', async () => {
  const res = await get('/api/images/wine/not-an-id', tokenFor(USER, ['user']));
  expect(res.status).toBe(400);
  expect(BottleImage.find).not.toHaveBeenCalled();
});
