/**
 * PUT /api/admin/wine-requests/:id/resolve (createNew) — the duplicate gate.
 *
 * WHY THIS TEST EXISTS (registry duplicate analysis 2026-07-22, RC4): the
 * createNew branch used to `new WineDefinition(...)` directly — no step-0
 * strip, no dedup probe, and it ALSO skipped the appellation tier-strip that
 * every other write surface got in v1.85.0. This suite pins the probe→409
 * gate, the canonicalized create, and the appellation fix.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineRequest', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn(), exists: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
// Identity by default so the tier-strip assertion below reads the
// normalizeAppellation output; the curated-registry test overrides it.
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
// The new producer gate (v1.111.0 audit MED-3) is DB-backed; unmocked it
// buffers on mongoose for 10s. Its verdicts have their own suites.
jest.mock('../../services/crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null) }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const wineRequestsRouter = require('./wineRequests');

const ADMIN_ID = '64b000000000000000000001';
const REQUEST_ID = '64b000000000000000000002';
const COUNTRY_ID = '64b0000000000000000000aa';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wine-requests', wineRequestsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

let requestDoc;
beforeEach(() => {
  jest.clearAllMocks();
  requestDoc = {
    _id: REQUEST_ID,
    status: 'pending',
    requestType: 'new_wine',
    wineName: 'Barolo del Comune',
    user: '64b000000000000000000003',
    image: null,
    save: jest.fn().mockResolvedValue({}),
    markModified: jest.fn(),
    populate: jest.fn().mockResolvedValue({}),
  };
  WineRequest.findById.mockResolvedValue(requestDoc);
  // The decision takes the request before it does anything (services/wineRequestOps.claimRequest).
  WineRequest.findOneAndUpdate.mockResolvedValue(requestDoc);
  WineRequest.updateOne.mockResolvedValue({});
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
  });
  Country.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Italy' }) }),
  });
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
  Bottle.distinct.mockResolvedValue([]);
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

const resolve = (body) => fetch(`${baseUrl}/api/admin/wine-requests/${REQUEST_ID}/resolve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

const CREATE_BODY = {
  createNew: true,
  adminNotes: '',
  wineData: {
    name: 'Cantina Rossi Barolo del Comune',
    producer: 'Cantina Rossi',
    country: COUNTRY_ID,
    appellation: 'Barolo DOCG',
    type: 'red',
  },
};

test('a probe hit returns 409 with candidates, creates nothing, request stays pending', async () => {
  findOrCreateWine.mockResolvedValue({
    wine: null,
    candidates: [{ wine: { _id: 'w1', name: 'Barolo del Comune', producer: 'Rossi', appellation: 'Barolo' }, score: 0.9 }],
  });

  const res = await resolve(CREATE_BODY);
  expect(res.status).toBe(409);
  const data = await res.json();
  expect(data.candidates[0]).toMatchObject({ _id: 'w1', score: 0.9 });
  expect(WineDefinition).not.toHaveBeenCalled();
  expect(requestDoc.save).not.toHaveBeenCalled();
});

test('clean create canonicalizes name + appellation and stamps createdVia ui', async () => {
  const res = await resolve(CREATE_BODY);
  expect(res.status).toBe(200);

  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.name).toBe('Barolo del Comune');   // "Cantina Rossi " prefix stripped
  expect(doc.appellation).toBe('Barolo');       // tier suffix stripped (the missed v1.85.0 fix)
  expect(doc.createdVia).toBe('ui');
  expect(requestDoc.save).toHaveBeenCalled();
});

// Tier-stripping alone is not enough: this branch builds the WineDefinition
// itself, so approving a request has to run the curated-registry resolver or
// it mints a decorated variant of an appellation the taxonomy already holds.
test('the STORED appellation is the resolver\'s canonical spelling', async () => {
  resolveCanonicalAppellation.mockResolvedValueOnce('Yecla');

  const res = await resolve({ ...CREATE_BODY, wineData: { ...CREATE_BODY.wineData, appellation: ' Yecla DO ' } });
  expect(res.status).toBe(200);

  expect(resolveCanonicalAppellation).toHaveBeenCalledWith('Yecla DO');
  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.appellation).toBe('Yecla');
  // The probe is keyed off the resolved value too, so the dedup match sees the
  // same string the registry already stores.
  expect(findOrCreateWine).toHaveBeenCalledWith(
    expect.objectContaining({ appellation: 'Yecla' }), ADMIN_ID, { matchOnly: true }
  );
});

test('confirmCreate skips the probe (explicit "create anyway")', async () => {
  const res = await resolve({ ...CREATE_BODY, confirmCreate: true });
  expect(res.status).toBe(200);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(WineDefinition).toHaveBeenCalled();
});

test('operator-injection shapes are rejected with 400, nothing queried', async () => {
  let res = await resolve({ ...CREATE_BODY, wineData: { ...CREATE_BODY.wineData, producer: { $gt: '' } } });
  expect(res.status).toBe(400);

  res = await resolve({ ...CREATE_BODY, wineData: { ...CREATE_BODY.wineData, country: { $ne: null } } });
  expect(res.status).toBe(400);

  expect(Country.findById).not.toHaveBeenCalled();
  expect(WineDefinition).not.toHaveBeenCalled();
});

test('a duplicate-key race resolves the request by LINKING the existing wine', async () => {
  const existing = { _id: 'wine-existing', name: 'Barolo del Comune', producer: 'Cantina Rossi' };
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
  });
  WineDefinition.findOne.mockResolvedValue(existing);

  const res = await resolve({ ...CREATE_BODY, confirmCreate: true });
  expect(res.status).toBe(200);
  expect(requestDoc.linkedWineDefinition).toBe('wine-existing');
  expect(requestDoc.save).toHaveBeenCalled();
});

// Provenance (2026-09-08): `createdBy` on the new wine is the ADMIN who
// approved it, which is the wrong answer to "a rights holder says this record
// is theirs — who gave it to us?". The contribution block answers that, and it
// is the only place the bridge origin survives once the audit rows expire.
test('the created wine records WHOSE contribution produced it, not just who approved it', async () => {
  requestDoc.via = 'bridge';
  requestDoc.bridgeKey = 'key-1';
  requestDoc.instanceHost = 'cellar.example.org';
  requestDoc.createdAt = new Date('2026-09-08T10:00:00Z');

  const res = await resolve(CREATE_BODY);
  expect(res.status).toBe(200);

  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.createdBy).toBe(ADMIN_ID);              // who performed the write
  expect(doc.contribution).toEqual({                 // whose data it is
    user: '64b000000000000000000003',
    via: 'bridge',
    request: REQUEST_ID,
    bridgeKey: 'key-1',
    instanceHost: 'cellar.example.org',
    at: new Date('2026-09-08T10:00:00Z'),
  });
});

test('a request with no recorded surface still names the contributor, and never invents one', async () => {
  const res = await resolve(CREATE_BODY);
  expect(res.status).toBe(200);
  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.contribution.user).toBe('64b000000000000000000003');
  expect(doc.contribution.bridgeKey).toBeNull();
  expect(doc.contribution.instanceHost).toBeNull();
  // Rows predating the origin fields fall back to the surface that has always
  // filed requests in a browser.
  expect(doc.contribution.via).toBe('ui');
});

// A wine minted by an approval is a creation like Admin → Wines create: it is
// audited as one and announced to IndexNow. Before, only the request's own
// resolve row existed (it links the wine, it does not say one was created).
describe('an approval that creates the wine', () => {
  const { logAudit } = require('../../services/audit');
  const { submitUrls } = require('../../services/indexNow');

  test('is audited as admin.wine.create (via wine-request) and pinged to IndexNow', async () => {
    const res = await resolve({ ...CREATE_BODY, confirmCreate: true });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.wine.create',
      { type: 'wine', id: 'wine-new' },
      { name: 'Barolo del Comune', producer: 'Cantina Rossi', via: 'wine-request', requestId: REQUEST_ID });
    expect(submitUrls).toHaveBeenCalledWith('/wines/wine-new');
  });

  test('the duplicate-key path links an existing wine: no creation row, no ping', async () => {
    WineDefinition.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this._id = 'wine-new';
      this.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    });
    WineDefinition.findOne.mockResolvedValue({ _id: 'wine-existing', name: 'Barolo del Comune', producer: 'Cantina Rossi' });

    const res = await resolve({ ...CREATE_BODY, confirmCreate: true });
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls.some(([, action]) => action === 'admin.wine.create')).toBe(false);
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('an unknown colour is refused with 400 like Admin → Wines create, nothing created', async () => {
    const res = await resolve({ ...CREATE_BODY, confirmCreate: true, wineData: { ...CREATE_BODY.wineData, type: 'sparkling', colour: 'rossé' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Colour must be one of:/);
    expect(WineDefinition).not.toHaveBeenCalled();
  });
});

// One decision at a time. Creating a wine comes long before the request's
// status is written, so two resolves that both saw "pending" used to create
// two wines. The request is taken first, and the second resolve stops there.
describe('a resolve takes the request before it creates anything', () => {
  const released = () => WineRequest.updateOne.mock.calls.filter(([, update]) => update && update.$set && update.$set.claimedAt === null);
  const settle = () => new Promise((r) => setTimeout(r, 30)); // the release runs after the answer is sent

  test('while another decision holds it: 409, and no wine is looked for or created', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue({ _id: REQUEST_ID });
    const res = await resolve(CREATE_BODY);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Someone else is deciding this wine request/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(requestDoc.save).not.toHaveBeenCalled();
    // it is not this resolve's to give back
    await settle();
    expect(released()).toHaveLength(0);
  });

  test('decided between the look and the take: 400 "already resolved", nothing created', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue(null);
    const res = await resolve(CREATE_BODY);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Wine request has already been resolved');
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('the take comes before the duplicate probe and the new wine', async () => {
    const res = await resolve(CREATE_BODY);
    expect(res.status).toBe(200);
    const claimAt = WineRequest.findOneAndUpdate.mock.invocationCallOrder[0];
    expect(claimAt).toBeLessThan(findOrCreateWine.mock.invocationCallOrder[0]);
    expect(claimAt).toBeLessThan(WineDefinition.mock.invocationCallOrder[0]);
  });

  test('a resolve that is refused gives the request back, so it can be decided again at once', async () => {
    const res = await resolve({ adminNotes: '' }); // neither a wine to link nor one to create
    expect(res.status).toBe(400);
    await settle();
    expect(released()).toEqual([[{ _id: REQUEST_ID, status: 'pending' }, { $set: { claimedAt: null } }]]);
  });

  test('a resolve that goes through gives nothing back: its own write clears the claim', async () => {
    const res = await resolve(CREATE_BODY);
    expect(res.status).toBe(200);
    await settle();
    expect(released()).toHaveLength(0);
    expect(requestDoc.claimedAt).toBeNull();
    expect(requestDoc.markModified).toHaveBeenCalledWith('claimedAt');
  });
});
