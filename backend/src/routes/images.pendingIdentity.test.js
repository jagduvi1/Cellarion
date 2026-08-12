/**
 * GET /api/images/:id — the SMALLEST widening that lets curation see a pending
 * wine's photos.
 *
 * Image BYTES have always been served by the unauthenticated random-UUID static
 * mount (app.js), so this metadata endpoint is the only gate that ever mattered
 * — which is exactly why the widening has to be narrow. Pinned here in both
 * directions: a somm/admin may read a label-scan row and the photos of a wine
 * that is STILL pending, and nothing else. An ordinary user's private bottle
 * gallery stays closed to curators, and a plain user gains nothing at all.
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
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const IMG = oid('6');
const UPLOADER = oid('1');
const CURATOR = oid('2');
const W1 = oid('a');
const B1 = oid('7');

const tokenFor = (id, roles = ['user']) => jwt.sign({ id, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.exists.mockResolvedValue(null);
  scanWine(null);
  Bottle.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
});

/** The wine a LABEL-SCAN row hangs off, as the gate loads it. */
const scanWine = (doc) => WineDefinition.findById.mockReturnValue({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
});
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const get = (token) => fetch(`${baseUrl}/api/images/${IMG}`, { headers: { Authorization: `Bearer ${token}` } });

const image = (over = {}) => ({
  _id: IMG, uploadedBy: UPLOADER, status: 'uploaded', visibility: 'private',
  bottle: null, wineDefinition: null, kind: 'bottle', ...over,
});

/**
 * The label-scan branch is PURPOSE-BOUND, not blanket. It used to authorize any
 * somm/admin for any label scan; a scan is curation evidence while its wine is
 * pending and for the grace window after it promotes (services/labelScanAccess)
 * — and outside that it is an ordinary private photo of a wine nobody has been
 * asked to identify.
 */
test('a somm may read the LABEL SCAN of a wine that is still pending', async () => {
  BottleImage.findById.mockResolvedValue(image({ kind: 'label-scan', wineDefinition: W1 }));
  scanWine({ _id: W1, pendingIdentity: true });

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(200);
});

test('…and on day 3 after promotion, so a wrong completion can be corrected against the label', async () => {
  BottleImage.findById.mockResolvedValue(
    image({ kind: 'label-scan', wineDefinition: W1, retainUntil: daysFromNow(4) })
  );
  scanWine({ _id: W1, pendingIdentity: false });

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(200);
});

test('once the window closes the scan is refused', async () => {
  BottleImage.findById.mockResolvedValue(
    image({ kind: 'label-scan', wineDefinition: W1, retainUntil: daysFromNow(-1) })
  );
  scanWine({ _id: W1, pendingIdentity: false });

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(404);
});

test('a scan attached to NO wine is not curation evidence — nobody\'s queue shows it', async () => {
  BottleImage.findById.mockResolvedValue(image({ kind: 'label-scan' }));

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(404);
  expect(WineDefinition.findById).not.toHaveBeenCalled();
});

test('a somm may read a bottle photo whose wine is STILL pending — named on the image', async () => {
  BottleImage.findById.mockResolvedValue(image({ wineDefinition: W1 }));
  WineDefinition.exists.mockResolvedValue({ _id: W1 });

  expect((await get(tokenFor(CURATOR, ['admin']))).status).toBe(200);
  expect(WineDefinition.exists).toHaveBeenCalledWith({ _id: W1, pendingIdentity: true });
});

test('…and one that only names the BOTTLE (the plain AddBottle upload path)', async () => {
  BottleImage.findById.mockResolvedValue(image({ bottle: B1 }));
  Bottle.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ wineDefinition: W1 }) }),
  });
  WineDefinition.exists.mockResolvedValue({ _id: W1 });

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(200);
});

test('a somm may NOT read an ordinary private photo of a COMPLETE wine', async () => {
  BottleImage.findById.mockResolvedValue(image({ wineDefinition: W1 }));
  WineDefinition.exists.mockResolvedValue(null); // not pending

  expect((await get(tokenFor(CURATOR, ['somm']))).status).toBe(404);
});

test('a plain user gains nothing — not even on a pending wine', async () => {
  BottleImage.findById.mockResolvedValue(image({ kind: 'label-scan' }));

  expect((await get(tokenFor(CURATOR, ['user']))).status).toBe(404);
});

test('the uploader still reaches their own image, as always', async () => {
  BottleImage.findById.mockResolvedValue(image({ kind: 'label-scan' }));

  expect((await get(tokenFor(UPLOADER))).status).toBe(200);
});
