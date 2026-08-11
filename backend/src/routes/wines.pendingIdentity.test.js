/**
 * Read-surface visibility for pending-identity wines, on the two routes where a
 * caller identity exists to compare against.
 *
 * The rule: hiding, not breaking. A stranger gets the SAME 404 a non-existent
 * id gets (so the row's existence never leaks); the CREATOR gets 200, because
 * their bottle page has to render the wine they just added; curation gets 200,
 * because completing the row is their job. The unauthenticated /public route
 * has nobody to compare against, so it simply excludes them.
 *
 * Also pins the scan-label change: the ORIGINAL frame is persisted and its id
 * returned, so the add flow can thread it to the commit.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn(), indexWine: jest.fn() }));
jest.mock('../services/labelScan', () => ({ scanLabelFull: jest.fn(), identifyWineFromQuery: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(async (b) => b),
  detectImageFormat: jest.fn(() => 'jpeg'),
}));
jest.mock('../services/imageOps', () => ({ persistLabelScan: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn(() => ({ bestMatch: null, bestScore: 0 })) }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn(async () => ({ ok: true, refund: jest.fn() })),
  isRefundableFailure: jest.fn(() => false),
  isRefundableScanError: jest.fn(() => false),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const { scanLabelFull } = require('../services/labelScan');
const { persistLabelScan } = require('../services/imageOps');
const winesRouter = require('./wines');

const oid = (c) => c.repeat(24);
const W1 = oid('a');
const CREATOR = oid('1');
const STRANGER = oid('2');
const SCAN_IMG = oid('5');

const tokenFor = (id, roles = ['user']) => jwt.sign({ id, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const populateChain = (doc) => ({ populate: jest.fn().mockResolvedValue(doc) });

const PENDING = {
  _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true, createdBy: CREATOR,
  grapes: [], country: null, region: null,
  // decorateGrapes calls toObject() when present; a lean-ish plain object is fine.
};

beforeEach(() => jest.clearAllMocks());

const getWine = (token) => fetch(`${baseUrl}/api/wines/${W1}`, {
  headers: { Authorization: `Bearer ${token}` },
});

describe('GET /api/wines/:id — pending rows are visible to their creator and to curation only', () => {
  beforeEach(() => WineDefinition.findById.mockReturnValue(populateChain(PENDING)));

  test('a stranger gets the same 404 a missing id gets', async () => {
    const res = await getWine(tokenFor(STRANGER));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Wine not found');
  });

  test('the CREATOR gets 200 — their bottle page must render', async () => {
    expect((await getWine(tokenFor(CREATOR))).status).toBe(200);
  });

  test.each([['somm'], ['admin']])('%s gets 200 — completing the row is their job', async (role) => {
    expect((await getWine(tokenFor(STRANGER, [role]))).status).toBe(200);
  });

  test('a NON-pending wine is unaffected for everyone', async () => {
    WineDefinition.findById.mockReturnValue(populateChain({
      _id: W1, name: 'Kaefferkopf', producer: 'Cave', grapes: [], createdBy: CREATOR,
    }));
    expect((await getWine(tokenFor(STRANGER))).status).toBe(200);
  });
});

describe('GET /api/wines/:idOrSlug/public — nobody to compare against, so simply excluded', () => {
  test('the query itself carries the exclusion', async () => {
    WineDefinition.findOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
    });

    const res = await fetch(`${baseUrl}/api/wines/${W1}/public`);

    expect(res.status).toBe(404);
    expect(WineDefinition.findOne).toHaveBeenCalledWith(expect.objectContaining({
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
    }));
  });
});

describe('POST /api/wines/scan-label — the original frame is kept, not discarded', () => {
  test('returns scanImageId so the add flow can thread it to the commit', async () => {
    scanLabelFull.mockResolvedValue({ name: 'Kaefferkopf', producer: '', grapes: [] });
    persistLabelScan.mockResolvedValue({ _id: SCAN_IMG });

    const res = await fetch(`${baseUrl}/api/wines/scan-label`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(CREATOR)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: Buffer.from('jpegbytes').toString('base64') }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scanImageId).toBe(SCAN_IMG);
    // The SANITIZED ORIGINAL is stored — not the background-removed render a
    // curator would have to squint at.
    expect(persistLabelScan).toHaveBeenCalledWith({ buffer: expect.any(Buffer), userId: CREATOR });
  });

  test('a storage failure still returns a successful scan — the photo is a bonus, not a gate', async () => {
    scanLabelFull.mockResolvedValue({ name: 'Kaefferkopf', producer: 'Cave', grapes: [] });
    persistLabelScan.mockResolvedValue(null);
    // With a producer present the route runs its registry-match probe, which
    // chains .populate() off findOne.
    WineDefinition.findOne.mockReturnValue(populateChain(null));
    WineDefinition.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });

    const res = await fetch(`${baseUrl}/api/wines/scan-label`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(CREATOR)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: Buffer.from('jpegbytes').toString('base64') }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).scanImageId).toBeNull();
  });
});
