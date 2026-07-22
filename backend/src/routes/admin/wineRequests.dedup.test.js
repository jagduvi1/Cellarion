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

jest.mock('../../models/WineRequest', () => ({ findById: jest.fn() }));
jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
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
    populate: jest.fn().mockResolvedValue({}),
  };
  WineRequest.findById.mockResolvedValue(requestDoc);
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

test('confirmCreate skips the probe (explicit "create anyway")', async () => {
  const res = await resolve({ ...CREATE_BODY, confirmCreate: true });
  expect(res.status).toBe(200);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(WineDefinition).toHaveBeenCalled();
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
