/**
 * POST /api/wines/scan-label-back — the back-label rescue endpoint, and the two
 * front-scan outcomes that lead to it.
 *
 * What is pinned here and nowhere else:
 *   - the endpoint is authenticated, and oversized front context is refused
 *     BEFORE any AI call (an oversized reject that still burned a vision call
 *     would be a cost attack with extra steps)
 *   - the front context reaching the service is what the client sent, and the
 *     back frame is persisted with side:'back'
 *   - debit/refund matches the front route exactly: a completed-but-unhelpful
 *     422 STAYS debited, a transport failure refunds
 *   - a PARTIAL front scan is a 200 that keeps the photo, and a full 422 hands
 *     the photo's id back anyway — both are what stop a pending wine from
 *     being minted with no evidence at all.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn(), indexWine: jest.fn() }));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  scanLabelBack: jest.fn(),
  // The merge is a PURE function with its own suite — use the real one, so this
  // suite proves the route wires it up rather than re-asserting its policy.
  mergeBackScan: jest.requireActual('../services/labelScan').mergeBackScan,
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(async (b) => b),
  detectImageFormat: jest.fn(() => 'jpeg'),
}));
jest.mock('../services/imageOps', () => ({ persistLabelScan: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
// The scan-time producer sanity check reads the four taxonomy collections; with
// no Mongo here it would degrade to a 10s buffering timeout per call. Its own
// behaviour is pinned in wines.suspectProducer.test.js — "clean" is the right
// default for a suite about the rescue endpoint's plumbing.
jest.mock('../services/crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null) }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn(() => ({ bestMatch: null, bestScore: 0 })) }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());

// `mock`-prefixed so the jest.mock factory below may close over it.
const mockRefund = jest.fn();
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn(async () => ({ ok: true, refund: mockRefund })),
  isRefundableFailure: jest.fn(() => false),
  // The REAL rule: everything except a 422 refunds.
  isRefundableScanError: jest.requireActual('../services/aiBudget').isRefundableScanError,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const { scanLabelFull, scanLabelBack } = require('../services/labelScan');
const { persistLabelScan } = require('../services/imageOps');
const { tryDebitAi } = require('../services/aiBudget');
const winesRouter = require('./wines');

const oid = (c) => c.repeat(24);
const USER = oid('1');
const FRONT_IMG = oid('5');
const BACK_IMG = oid('6');
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

beforeEach(() => {
  jest.clearAllMocks();
  tryDebitAi.mockResolvedValue({ ok: true, refund: mockRefund });
  // No registry match unless a test says otherwise.
  WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  WineDefinition.find.mockReturnValue({
    populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
});

const post = (body, headers = {}) => fetch(`${baseUrl}/api/wines/scan-label-back`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const auth = () => ({ Authorization: `Bearer ${token}` });

describe('POST /api/wines/scan-label-back — the gate', () => {
  test('401 without a token — this spends AI budget', async () => {
    expect((await post({ image: IMAGE })).status).toBe(401);
    expect(scanLabelBack).not.toHaveBeenCalled();
  });

  test('400 without an image', async () => {
    const res = await post({}, auth());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Image is required');
    expect(tryDebitAi).not.toHaveBeenCalled();
  });

  test('an oversized frontExtracted field is refused BEFORE any AI call or debit', async () => {
    const res = await post({ image: IMAGE, frontExtracted: { name: 'x'.repeat(201) } }, auth());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/frontExtracted.name must be a string of 200/);
    expect(tryDebitAi).not.toHaveBeenCalled();
    expect(scanLabelBack).not.toHaveBeenCalled();
  });

  test('too many grapes is refused the same way', async () => {
    const res = await post({
      image: IMAGE,
      frontExtracted: { grapes: Array.from({ length: 21 }, (_, i) => `g${i}`) },
    }, auth());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 20 entries/);
    expect(scanLabelBack).not.toHaveBeenCalled();
  });

  test('a non-object frontExtracted is refused', async () => {
    const res = await post({ image: IMAGE, frontExtracted: ['name'] }, auth());
    expect(res.status).toBe(400);
    expect(scanLabelBack).not.toHaveBeenCalled();
  });

  test('a non-image payload is refused before the AI call', async () => {
    const { sanitizeImageBuffer } = require('../services/imageSanitizer');
    sanitizeImageBuffer.mockRejectedValueOnce(new Error('not an image'));

    const res = await post({ image: IMAGE }, auth());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a valid JPEG, PNG, or WebP/);
    expect(scanLabelBack).not.toHaveBeenCalled();
  });
});

describe('POST /api/wines/scan-label-back — the happy path', () => {
  test('merges server-side, persists the back frame with side:"back", and returns both ids', async () => {
    scanLabelBack.mockResolvedValue({
      name: null, producer: 'Cave de Kaysersberg', country: 'France', grapes: ['Riesling'],
    });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });

    const res = await post({
      image: IMAGE,
      frontImage: IMAGE,
      frontExtracted: { name: 'Kaefferkopf', producer: '', grapes: [] },
      frontScanImageId: FRONT_IMG,
    }, auth());
    const body = await res.json();

    expect(res.status).toBe(200);
    // Fill-blanks-only: the front name stood, the back producer landed.
    expect(body.merged).toMatchObject({
      name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
    });
    expect(body.filled).toEqual(expect.arrayContaining(['producer', 'country', 'grapes']));
    expect(body.conflicts).toEqual([]);
    expect(body.backScanImageId).toBe(BACK_IMG);
    expect(body.frontScanImageId).toBe(FRONT_IMG);

    expect(persistLabelScan).toHaveBeenCalledWith({
      buffer: expect.any(Buffer), userId: USER, side: 'back',
    });
  });

  test('the front context is handed to the service as the client sent it', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Cave' });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });

    await post({
      image: IMAGE,
      frontImage: IMAGE,
      frontExtracted: { name: 'Kaefferkopf', appellation: 'Alsace' },
    }, auth());

    expect(scanLabelBack).toHaveBeenCalledWith(expect.objectContaining({
      backImage: expect.any(String),
      frontImage: expect.any(String),
      frontExtracted: { name: 'Kaefferkopf', appellation: 'Alsace' },
    }));
  });

  test('a disagreement is reported with the FRONT value kept', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Wolfberger' });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });

    const body = await (await post({
      image: IMAGE,
      frontExtracted: { name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' },
    }, auth())).json();

    expect(body.merged.producer).toBe('Cave de Kaysersberg');
    expect(body.conflicts).toEqual([
      { field: 'producer', front: 'Cave de Kaysersberg', back: 'Wolfberger' },
    ]);
  });

  test('the registry match is re-run on the MERGED identity, not the front one', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Cave de Kaysersberg' });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });
    const matched = { _id: oid('9'), name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' };
    WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(matched) });

    const body = await (await post({
      image: IMAGE,
      // A producerless front identity could never have matched anything: the
      // exact-key lookup needs both fields.
      frontExtracted: { name: 'Kaefferkopf', producer: '' },
    }, auth())).json();

    expect(body.match).toMatchObject({ confidence: 1 });
    expect(body.match.wine._id).toBe(matched._id);
    expect(WineDefinition.findOne).toHaveBeenCalled();
  });

  test('a storage failure still returns the scan — the photo is a bonus, not a gate', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Cave' });
    persistLabelScan.mockResolvedValue(null);

    const body = await (await post({ image: IMAGE, frontExtracted: { name: 'K' } }, auth())).json();
    expect(body.backScanImageId).toBeNull();
    expect(body.merged.producer).toBe('Cave');
  });

  test('a junk frontScanImageId is nulled, never echoed back for the commit to use', async () => {
    scanLabelBack.mockResolvedValue({ producer: 'Cave' });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });

    const body = await (await post({
      image: IMAGE, frontScanImageId: 'not-an-id',
    }, auth())).json();
    expect(body.frontScanImageId).toBeNull();
  });
});

describe('POST /api/wines/scan-label-back — budget semantics match the front route', () => {
  test('an exhausted budget is a 429 and never calls the model', async () => {
    tryDebitAi.mockResolvedValue({ ok: false, reason: 'user_budget', retryAfterSeconds: 3600 });

    const res = await post({ image: IMAGE }, auth());
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('ai_budget_exhausted');
    expect(scanLabelBack).not.toHaveBeenCalled();
  });

  test('a demo account is a distinct 403, not a "try again at midnight"', async () => {
    tryDebitAi.mockResolvedValue({ ok: false, reason: 'demo_disabled' });

    const res = await post({ image: IMAGE }, auth());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('demo_ai_disabled');
  });

  test('a completed-but-unhelpful 422 STAYS debited — this is the budget bypass being closed', async () => {
    scanLabelBack.mockRejectedValue(Object.assign(new Error('Could not read back label'), { status: 422 }));

    const res = await post({ image: IMAGE }, auth());
    expect(res.status).toBe(422);
    expect(mockRefund).not.toHaveBeenCalled();
  });

  test('a transport failure refunds — no billable completion happened', async () => {
    scanLabelBack.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { status: 503 }));

    const res = await post({ image: IMAGE }, auth());
    expect(res.status).toBe(503);
    expect(mockRefund).toHaveBeenCalled();
  });
});

describe('POST /api/wines/scan-label — a half-read label keeps its photo', () => {
  const postFront = (body) => fetch(`${baseUrl}/api/wines/scan-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth() },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    // rembg unreachable — the route falls back to the sanitized original.
    global.fetch = fetch;
  });

  test('allowPartial is on, and a partial extraction is a 200 that still stores the frame', async () => {
    scanLabelFull.mockResolvedValue({ name: 'Kaefferkopf', producer: '', grapes: [], partial: true });
    persistLabelScan.mockResolvedValue({ _id: FRONT_IMG });

    const res = await postFront({ image: IMAGE });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(scanLabelFull).toHaveBeenCalledWith(expect.any(String), 'image/jpeg', { allowPartial: true });
    expect(body.extracted.partial).toBe(true);
    expect(body.scanImageId).toBe(FRONT_IMG);
    // A producerless identity cannot match anything — the exact-key lookup is
    // never even attempted.
    expect(body.match).toBeNull();
    expect(WineDefinition.findOne).not.toHaveBeenCalled();
  });

  test('a FULL 422 returns the stored frame\'s id, so manual entry still supplies evidence', async () => {
    scanLabelFull.mockRejectedValue(
      Object.assign(new Error('Could not identify wine from label'), { status: 422 })
    );
    persistLabelScan.mockResolvedValue({ _id: FRONT_IMG });

    const res = await postFront({ image: IMAGE });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('Could not identify wine from label');
    expect(body.scanImageId).toBe(FRONT_IMG);
    expect(persistLabelScan).toHaveBeenCalledWith({
      buffer: expect.any(Buffer), userId: USER, side: 'front',
    });
    // Still non-refundable: the vision call completed.
    expect(mockRefund).not.toHaveBeenCalled();
  });

  test('a 422 whose frame could not be stored says so with null rather than failing differently', async () => {
    scanLabelFull.mockRejectedValue(Object.assign(new Error('Could not read label'), { status: 422 }));
    persistLabelScan.mockResolvedValue(null);

    const body = await (await postFront({ image: IMAGE })).json();
    expect(body.scanImageId).toBeNull();
  });

  test('a NON-422 failure keeps its old shape — no photo, and a refund', async () => {
    scanLabelFull.mockRejectedValue(Object.assign(new Error('Unsupported image type'), { status: 400 }));

    const res = await postFront({ image: IMAGE });
    expect(res.status).toBe(400);
    expect((await res.json()).scanImageId).toBeUndefined();
    expect(persistLabelScan).not.toHaveBeenCalled();
    expect(mockRefund).toHaveBeenCalled();
  });
});

// ── The UI round-trip (release-audit HIGH-1) ────────────────────────────────
// The client forwards /scan-label's `extracted` object VERBATIM — including
// `partial: true`, the very flag that makes the rescue worth offering. The
// first validator looped over every key and 400'd on the boolean, so the
// endpoint rejected the feature's primary case (and a model returning a
// numeric vintage tripped it too). These pin the allowlist behaviour.
describe('POST /api/wines/scan-label-back — the UI round-trip (HIGH-1)', () => {
  test('accepts the verbatim front-scan object: partial flag, numeric vintage, junk keys', async () => {
    scanLabelBack.mockResolvedValue({ name: 'La Orphica' });
    persistLabelScan.mockResolvedValue({ _id: BACK_IMG });

    const res = await post({
      image: IMAGE,
      frontExtracted: {
        name: '', producer: 'Bodegas Trenza', vintage: 2019,
        partial: true, confidence: 0.4, junk: { deep: true }, grapes: [],
      },
    }, auth());
    const body = await res.json();

    expect(res.status).toBe(200);
    // Only allowlisted STRING fields reach the prompt/service — the numeric
    // vintage and the flags are dropped, never fatal.
    expect(scanLabelBack).toHaveBeenCalledWith(expect.objectContaining({
      frontExtracted: { name: '', producer: 'Bodegas Trenza', grapes: [] },
    }));
    // …and junk keys cannot ride mergeBackScan's spread back out (INFO-1).
    expect(body.merged.junk).toBeUndefined();
    expect(body.merged.confidence).toBeUndefined();
    expect(body.merged.name).toBe('La Orphica');
  });

  test('allowlisted fields are still length-capped', async () => {
    const res = await post({
      image: IMAGE,
      frontExtracted: { producer: 'x'.repeat(201), partial: true },
    }, auth());
    expect(res.status).toBe(400);
    expect(scanLabelBack).not.toHaveBeenCalled();
  });
});
