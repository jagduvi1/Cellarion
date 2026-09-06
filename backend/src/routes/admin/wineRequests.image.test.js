/**
 * PUT /api/admin/wine-requests/:id/resolve (createNew) — the image field.
 *
 * Audit 2026-09 F06-1: the request's `image` is chosen by ANY user, and the
 * approval used to store `image || wineRequest.image || null` — so a blanked
 * field silently fell back to the requester's value, and nothing checked its
 * shape. A protocol-relative `//attacker/x` then reached WineDefinition.image,
 * where every viewer's AuthImage fetched it with the bearer token attached.
 * This suite pins: explicit blank ⇒ null; only http(s) / inline / own-upload
 * shapes are stored; a bad value (typed or inherited) is a 400, nothing minted.
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
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../../services/crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null) }));
jest.mock('../../services/producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (p) => p) }));

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

const resolve = (wineData) => fetch(`${baseUrl}/api/admin/wine-requests/${REQUEST_ID}/resolve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify({
    createNew: true,
    confirmCreate: true,
    adminNotes: '',
    wineData: { name: 'Barolo del Comune', producer: 'Cantina Rossi', country: COUNTRY_ID, type: 'red', ...wineData },
  }),
});

test('an explicitly blank image stores null — it does NOT fall back to the requester\'s value', async () => {
  requestDoc.image = 'https://cdn.example.com/label.png';
  const res = await resolve({ image: '' });
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBeNull();
});

test('an omitted image inherits the request\'s value only when that value is a safe shape', async () => {
  requestDoc.image = '/api/uploads/abc-123.png';
  const res = await resolve({});
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBe('/api/uploads/abc-123.png');
});

test('a protocol-relative value inherited from the request is refused, nothing is minted', async () => {
  requestDoc.image = '//attacker.example/pixel.png';
  const res = await resolve({});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/Wine image/);
  expect(WineDefinition).not.toHaveBeenCalled();
  expect(requestDoc.save).not.toHaveBeenCalled();
});

test('a javascript: or private-host value typed by the admin is refused too', async () => {
  let res = await resolve({ image: 'javascript:alert(1)' });
  expect(res.status).toBe(400);
  res = await resolve({ image: 'http://127.0.0.1/x.png' });
  expect(res.status).toBe(400);
  expect(WineDefinition).not.toHaveBeenCalled();
});

test('a public https link typed by the admin is stored as given', async () => {
  const res = await resolve({ image: 'https://cdn.example.com/bottle.png' });
  expect(res.status).toBe(200);
  expect(WineDefinition.mock.calls[0][0].image).toBe('https://cdn.example.com/bottle.png');
});
