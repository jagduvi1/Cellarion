/**
 * Audit 2026-09 S4-3 — push subscriptions per account are capped (the oldest
 * is evicted past MAX_PUSH_SUBSCRIPTIONS) and endpoints must be https: every
 * notification fans out to every subscription as a signed HTTPS POST to a
 * host the client chose.
 */
const express = require('express');
const http = require('http');

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'a'.repeat(24), roles: ['user'] }; next(); },
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
const mockFind = jest.fn();
const mockDeleteMany = jest.fn(async () => ({}));
const mockUpsert = jest.fn(async () => ({}));
jest.mock('../models/PushSubscription', () => ({
  find: (...a) => mockFind(...a),
  deleteMany: (...a) => mockDeleteMany(...a),
  findOneAndUpdate: (...a) => mockUpsert(...a),
  updateOne: jest.fn(async () => ({})),
  deleteOne: jest.fn(async () => ({})),
  countDocuments: jest.fn(async () => 0),
  findOne: jest.fn(async () => null),
}));

const router = require('./pushSubscriptions');

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/push-subscriptions', router);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const existing = (n) => Array.from({ length: n }, (_, i) => ({ _id: `sub${i}` }));
const chain = (rows) => ({ sort: () => ({ select: () => ({ lean: async () => rows }) }) });
const post = (body) => fetch(`${base}/api/push-subscriptions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const KEYS = { p256dh: 'p', auth: 'a' };

beforeEach(() => { jest.clearAllMocks(); });

test('a new device under the cap is saved without evicting anything', async () => {
  mockFind.mockReturnValue(chain(existing(3)));
  const { status } = await post({ endpoint: 'https://push.example/abc', keys: KEYS });
  expect(status).toBe(200);
  expect(mockDeleteMany).not.toHaveBeenCalled();
  expect(mockUpsert).toHaveBeenCalledTimes(1);
});

test('at the cap the oldest subscription is evicted so the newest device still works', async () => {
  mockFind.mockReturnValue(chain(existing(10)));
  const { status } = await post({ endpoint: 'https://push.example/new', keys: KEYS });
  expect(status).toBe(200);
  expect(mockDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['sub0'] } });
  // The lookup excluded the endpoint being (re-)registered, so re-subscribing
  // the same device never counts against itself.
  expect(mockFind.mock.calls[0][0]).toEqual({ user: 'a'.repeat(24), endpoint: { $ne: 'https://push.example/new' } });
});

test('well over the cap (legacy rows) trims down to the cap in one go', async () => {
  mockFind.mockReturnValue(chain(existing(14)));
  await post({ endpoint: 'https://push.example/new', keys: KEYS });
  expect(mockDeleteMany.mock.calls[0][0]._id.$in).toEqual(['sub0', 'sub1', 'sub2', 'sub3', 'sub4']);
});

test('an endpoint that is not https, or is absurdly long, is refused before any write', async () => {
  mockFind.mockReturnValue(chain([]));
  expect((await post({ endpoint: 'http://push.example/abc', keys: KEYS })).status).toBe(400);
  expect((await post({ endpoint: 'https://push.example/' + 'x'.repeat(2100), keys: KEYS })).status).toBe(400);
  expect(mockUpsert).not.toHaveBeenCalled();
});
