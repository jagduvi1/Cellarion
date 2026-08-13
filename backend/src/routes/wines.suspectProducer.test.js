/**
 * SCAN-TIME producer sanity — POST /api/wines/scan-label and the back-label
 * rescue's merged response.
 *
 * THE INCIDENT (prod 2026-08-13): the extraction came back with producer "Pays
 * d'Oc Organic Wine" and name "Chardonnay Reserve". Both boxes were filled, so
 * `partial` was false, so the client showed the READ-ONLY confirmation card,
 * the user pressed confirm, and the registry gained a published wine whose
 * producer is a region plus marketing copy. The half-read machinery that exists
 * for exactly this moment (v1.109.0) never fired, because it only asks whether
 * a field is EMPTY.
 *
 * The fix reuses that machinery rather than adding to it: a producer the
 * cross-field rules refuse makes the scan `partial`, which the client already
 * routes to the EDITABLE prefilled form plus the back-label offer — no new
 * step, nothing rejected, and the user can simply correct the box. If they
 * confirm it unchanged, the mint chokepoint files the row pending
 * (services/findOrCreateWine.crossFieldProducer.test.js).
 *
 * `producer_suspect` carries the rule id so the response says WHY, not just
 * "partial".
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn(), indexWine: jest.fn() }));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  scanLabelBack: jest.fn(),
  // The merge is a PURE function with its own suite — the real one, so this
  // suite proves the route re-checks the MERGED identity rather than the front.
  mergeBackScan: jest.requireActual('../services/labelScan').mergeBackScan,
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(async (b) => b),
  detectImageFormat: jest.fn(() => 'jpeg'),
}));
jest.mock('../services/imageOps', () => ({ persistLabelScan: jest.fn(async () => ({ _id: 'img-1' })) }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn(() => ({ bestMatch: null, bestScore: 0 })) }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn(async () => ({ ok: true, refund: jest.fn() })),
  isRefundableFailure: jest.fn(() => false),
  isRefundableScanError: jest.requireActual('../services/aiBudget').isRefundableScanError,
}));
// The verdict itself is the cross-field rules' own business (they have three
// suites). What this one pins is that the ROUTE asks, and what it does with the
// answer.
jest.mock('../services/crossFieldScan', () => ({ detectScanSuspectProducer: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const { scanLabelFull, scanLabelBack } = require('../services/labelScan');
const { detectScanSuspectProducer } = require('../services/crossFieldScan');
const winesRouter = require('./wines');

const USER = '1'.repeat(24);
const IMAGE = Buffer.from('jpegbytes').toString('base64');
const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/wines', winesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  // rembg unreachable — the route falls back to the sanitized original.
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  detectScanSuspectProducer.mockResolvedValue(null);
  WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  WineDefinition.find.mockReturnValue({
    populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
});
afterEach(() => { global.fetch = realFetch; });

const post = (path, body) => realFetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

const THE_ROW = { name: 'Chardonnay Reserve', producer: "Pays d'Oc Organic Wine", country: 'France' };

describe('POST /api/wines/scan-label — a producer that is not a producer', () => {
  test('the prod row: complete-looking, now marked partial with the rule that caught it', async () => {
    scanLabelFull.mockResolvedValue({ ...THE_ROW });
    detectScanSuspectProducer.mockResolvedValue({
      check: 'producer-is-appellation.v1', detail: "Pays d'Oc", hard: true,
    });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(body.extracted.partial).toBe(true);
    expect(body.extracted.producer_suspect).toBe('producer-is-appellation.v1');
    // The fields the model read are KEPT — the user edits them, they are never
    // thrown away, and adding is not made harder.
    expect(body.extracted.producer).toBe("Pays d'Oc Organic Wine");
    expect(body.extracted.name).toBe('Chardonnay Reserve');
  });

  test('it is a 200 with the frame kept, exactly like a half-read label', async () => {
    scanLabelFull.mockResolvedValue({ ...THE_ROW });
    detectScanSuspectProducer.mockResolvedValue({ check: 'producer-is-grape.v1', detail: 'Syrah', hard: true });

    const res = await post('/api/wines/scan-label', { image: IMAGE });

    expect(res.status).toBe(200);
    expect((await res.json()).scanImageId).toBe('img-1');
  });

  test('the rules are asked about the EXTRACTED identity', async () => {
    scanLabelFull.mockResolvedValue({ ...THE_ROW, appellation: 'Pays d\'Oc' });

    await post('/api/wines/scan-label', { image: IMAGE });

    expect(detectScanSuspectProducer).toHaveBeenCalledWith({
      name: 'Chardonnay Reserve',
      producer: "Pays d'Oc Organic Wine",
      appellation: "Pays d'Oc",
    });
  });

  test('a clean producer is untouched — no partial, no suspect key', async () => {
    scanLabelFull.mockResolvedValue({ name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France' });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(body.extracted.partial).toBeUndefined();
    expect(body.extracted).not.toHaveProperty('producer_suspect');
  });

  test('an EMPTY producer is not asked about — that is the older half-read case', async () => {
    scanLabelFull.mockResolvedValue({ name: 'Kaefferkopf', producer: '', partial: true });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(detectScanSuspectProducer).not.toHaveBeenCalled();
    expect(body.extracted.partial).toBe(true);           // untouched
  });

  test('SOFT hit (place-plus-filler) with NO registry match → flagged partial', async () => {
    scanLabelFull.mockResolvedValue({ ...THE_ROW });
    detectScanSuspectProducer.mockResolvedValue({
      check: 'producer-place-plus-filler.scan', detail: '"Pays d\'Oc" + organic wine', hard: false,
    });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(body.extracted.partial).toBe(true);
    expect(body.extracted.producer_suspect).toBe('producer-place-plus-filler.scan');
  });

  test('SOFT hit with a registry MATCH is NOT flagged — Château Margaux keeps its one-tap card (#942)', async () => {
    const { findBestMatch } = require('../services/wineMatching');
    scanLabelFull.mockResolvedValue({ name: 'Château Margaux', producer: 'Château Margaux', country: 'France' });
    findBestMatch.mockReturnValueOnce({
      bestMatch: { _id: 'w1', name: 'Château Margaux', producer: 'Château Margaux' }, bestScore: 0.95,
    });
    detectScanSuspectProducer.mockResolvedValue({
      check: 'producer-place-plus-filler.scan', detail: '"Margaux" + chateau', hard: false,
    });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(body.match).toBeTruthy();
    expect(body.extracted.partial).toBeUndefined();
    expect(body.extracted).not.toHaveProperty('producer_suspect');
  });

  test('a HARD hit with a registry match is NOT flagged either — confirming attaches to the existing row, minting nothing (audit M-3)', async () => {
    const { findBestMatch } = require('../services/wineMatching');
    scanLabelFull.mockResolvedValue({ ...THE_ROW });
    findBestMatch.mockReturnValueOnce({
      bestMatch: { _id: 'w2', name: 'Chardonnay Reserve', producer: "Pays d'Oc Organic Wine" }, bestScore: 0.9,
    });
    detectScanSuspectProducer.mockResolvedValue({
      check: 'producer-is-appellation.v1', detail: "Pays d'Oc", hard: true,
    });

    const body = await (await post('/api/wines/scan-label', { image: IMAGE })).json();

    expect(body.match).toBeTruthy();
    expect(body.extracted.partial).toBeUndefined();
    // The one-tap card stays; if the user instead edits into a NEW identity,
    // the mint gate still files a hard-hit producer pending on commit.
  });

  test('a taxonomy failure never costs the user a paid scan', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    scanLabelFull.mockResolvedValue({ ...THE_ROW });
    detectScanSuspectProducer.mockRejectedValue(new Error('mongo down'));

    const res = await post('/api/wines/scan-label', { image: IMAGE });

    expect(res.status).toBe(200);
    expect((await res.json()).extracted.partial).toBeUndefined();
    warn.mockRestore();
  });
});

describe('POST /api/wines/scan-label-back — the MERGED identity is re-checked', () => {
  test('a back label that fills the producer box with a place is flagged on the merge', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Produit de France' });
    detectScanSuspectProducer.mockResolvedValue({
      check: 'producer-is-country.v1', detail: 'France', hard: true,
    });

    const body = await (await post('/api/wines/scan-label-back', {
      image: IMAGE,
      frontExtracted: { name: 'Chardonnay Reserve' },
    })).json();

    expect(body.merged.producer).toBe('Produit de France');
    expect(body.merged.partial).toBe(true);
    expect(body.merged.producer_suspect).toBe('producer-is-country.v1');
    // Re-evaluated on the MERGE, not carried over from the front response: the
    // producer being judged here did not exist when the front scan ran.
    expect(detectScanSuspectProducer).toHaveBeenCalledWith(
      expect.objectContaining({ producer: 'Produit de France' }));
  });

  test('a rescue that produces a real producer is left clean', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Domaine Gayda' });

    const body = await (await post('/api/wines/scan-label-back', {
      image: IMAGE,
      frontExtracted: { name: 'Chardonnay Reserve' },
    })).json();

    expect(body.merged.partial).toBeUndefined();
    expect(body.merged).not.toHaveProperty('producer_suspect');
  });
});
