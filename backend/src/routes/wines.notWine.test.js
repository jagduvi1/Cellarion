/**
 * POST /api/wines/:id/not-wine — a member moves a drink that is not wine to
 * the Other category. The decision lives in services/nonWineOps (its own
 * suite); this pins the route's gates and status mapping.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  search: jest.fn(async () => ({ ids: [], estimatedTotalHits: 0 })),
}));
jest.mock('../services/ownHiddenWines', () => ({ findOwnHiddenWineIds: jest.fn() }));
jest.mock('../services/labelScan', () => ({ scanLabelFull: jest.fn(), identifyWineFromQuery: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn(), detectImageFormat: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn().mockReturnValue(false),
  isRefundableScanError: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/nonWineOps', () => ({ markNotWineByMember: jest.fn() }));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { markNotWineByMember } = require('../services/nonWineOps');
const winesRouter = require('./wines');

const USER_ID = '64b000000000000000000001';
const WINE = '64b0000000000000000000c1';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const token = (extra = {}) => jwt.sign({ id: USER_ID, roles: ['user'], ...extra }, 'test-secret');
const post = (id, auth = token()) => fetch(`${baseUrl}/api/wines/${id}/not-wine`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
});

beforeEach(() => jest.clearAllMocks());

test('an applied move answers 200 with the Other category', async () => {
  markNotWineByMember.mockResolvedValue({ ok: true, status: 'applied', category: 'other', holders: 1, pendingRemoved: 0 });
  const res = await post(WINE);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'applied', category: 'other', holders: 1 });
  expect(markNotWineByMember).toHaveBeenCalledWith(expect.objectContaining({ wineId: WINE, userId: USER_ID, via: 'member' }));
});

test('a filed proposal and a pending one answer 200 too, with the status the page explains', async () => {
  markNotWineByMember.mockResolvedValue({ ok: true, status: 'filed', category: 'wine', holders: 6 });
  let res = await post(WINE);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'filed', category: 'wine', holders: 6 });

  markNotWineByMember.mockResolvedValue({ ok: true, status: 'pending', category: 'wine', holders: 6 });
  res = await post(WINE);
  expect((await res.json()).status).toBe('pending');
});

test('refusals map to 403 / 404 / 400', async () => {
  markNotWineByMember.mockResolvedValue({ ok: false, code: 'forbidden', message: 'no bottle' });
  expect((await post(WINE)).status).toBe(403);
  markNotWineByMember.mockResolvedValue({ ok: false, code: 'not_found', message: 'gone' });
  expect((await post(WINE)).status).toBe(404);
  markNotWineByMember.mockResolvedValue({ ok: false, code: 'invalid', message: 'bad id' });
  expect((await post('nope')).status).toBe(400);
});

test('needs a signed-in member', async () => {
  expect((await post(WINE, null)).status).toBe(401);
  expect(markNotWineByMember).not.toHaveBeenCalled();
});
