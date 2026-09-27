/**
 * GET /api/cellars/:id/history and /multi/history — paged with ?limit.
 *
 * WHY THIS TEST EXISTS:
 * The history page used to receive and render every consumed bottle at once
 * (up to 10,000); a history imported from another app can hold thousands.
 * With ?limit (and ?skip) the routes send one page, newest-consumed first,
 * with the total and the per-reason counts the page's summary shows. Without
 * ?limit the whole history comes back as before, now with the same totals.
 *
 * Real router + real requireAuth (HS256 test token); the Bottle model is a
 * small in-memory fake that honours filter, sort, skip and limit.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({}));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/PendingShare', () => ({}));
jest.mock('../models/ClimateDevice', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const bottleSearch = require('../services/bottleSearch');
const cellarsRouter = require('./cellars');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000c1';
const CELLAR_2 = '64b0000000000000000000c2';
const id = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const day = (d) => new Date(Date.UTC(2026, 0, d));

// Five consumed bottles; the newest first once sorted.
const ROWS = [
  { _id: id(11), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(1) },
  { _id: id(12), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(5) },
  { _id: id(13), cellar: CELLAR_ID, status: 'gifted', consumedReason: 'gifted', consumedAt: day(3) },
  { _id: id(14), cellar: CELLAR_2, status: 'other', consumedReason: 'broken', consumedAt: day(4) }, // unknown reason → other
  { _id: id(15), cellar: CELLAR_ID, status: 'drank', consumedReason: null, consumedAt: day(2) }, // no reason → its status
];

function request(url) {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: url, method: 'GET',
        headers: { authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// An in-memory Bottle.find: filter by cellar / _id / status, then sort, skip, limit.
let finds = [];
function bottleQuery(filter) {
  const record = { filter, sort: null, skip: 0, limit: Infinity };
  finds.push(record);
  const matches = (r) => {
    if (filter.user) return false; // sibling-photo lookup
    if (filter._id && filter._id.$in) return filter._id.$in.map(String).includes(r._id);
    const cellars = filter.cellar && filter.cellar.$in ? filter.cellar.$in.map(String) : [String(filter.cellar)];
    return cellars.includes(r.cellar);
  };
  const q = {
    populate: () => q, select: () => q,
    sort: (s) => { record.sort = s; return q; },
    skip: (n) => { record.skip = n; return q; },
    limit: (n) => { record.limit = n; return q; },
    lean: async () => {
      let rows = ROWS.filter(matches).map((r) => ({ ...r }));
      if (record.sort && record.sort.consumedAt) rows.sort((a, b) => b.consumedAt - a.consumedAt || (a._id < b._id ? 1 : -1));
      return rows.slice(record.skip, record.skip + record.limit);
    },
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  finds = [];
  const cellar = { _id: CELLAR_ID, name: 'Home', user: { _id: USER_ID, username: 'me' }, members: [], deletedAt: null, userColors: [] };
  Cellar.findById.mockImplementation(() => ({
    populate: () => Promise.resolve({ ...cellar, toObject: () => ({ ...cellar }) }),
  }));
  Cellar.find.mockReturnValue({
    lean: async () => [{ ...cellar, _id: CELLAR_ID, user: USER_ID }, { ...cellar, _id: CELLAR_2, user: USER_ID }],
  });
  Bottle.find.mockImplementation(bottleQuery);
  const imageChain = { sort: () => imageChain, lean: async () => [] };
  BottleImage.find.mockReturnValue(imageChain);
  bottleSearch.bottleFacets.mockResolvedValue({ facetDistribution: {}, baseFacetDistribution: {}, facetMeta: {} });
});

const ids = (bottles) => bottles.map((b) => b._id);

describe('GET /api/cellars/:id/history', () => {
  test('?limit: one page newest-consumed first, the total and the per-reason counts of the whole history', async () => {
    const first = await request(`/api/cellars/${CELLAR_ID}/history?limit=2`);
    expect(first.status).toBe(200);
    expect(ids(first.body.bottles)).toEqual([id(12), id(13)]);
    expect(first.body.total).toBe(4);
    expect(first.body.reasonCounts).toEqual({ drank: 3, gifted: 1, sold: 0, other: 0 });
    // The order is MongoDB's, with _id breaking ties, over four fields only.
    expect(finds[0].sort).toEqual({ consumedAt: -1, _id: -1 });

    const second = await request(`/api/cellars/${CELLAR_ID}/history?limit=2&skip=2`);
    expect(ids(second.body.bottles)).toEqual([id(15), id(11)]);
    expect(second.body.total).toBe(4);
  });

  test('a search pages its own hits, newest-consumed first', async () => {
    bottleSearch.searchBottles.mockResolvedValue({
      ids: [id(11), id(13)], total: 2, facetDistribution: {}, baseFacetDistribution: {}, facetMeta: {},
    });
    const { body } = await request(`/api/cellars/${CELLAR_ID}/history?search=x&limit=1`);
    expect(ids(body.bottles)).toEqual([id(13)]);
    expect(body.total).toBe(2);
    expect(body.reasonCounts).toEqual({ drank: 1, gifted: 1, sold: 0, other: 0 });
  });

  test('without ?limit: the whole history, as before, with the same totals', async () => {
    const { body } = await request(`/api/cellars/${CELLAR_ID}/history`);
    expect(ids(body.bottles)).toEqual([id(12), id(13), id(15), id(11)]);
    expect(body.total).toBe(4);
    expect(body.reasonCounts).toEqual({ drank: 3, gifted: 1, sold: 0, other: 0 });
  });
});

describe('GET /api/cellars/multi/history', () => {
  test('?limit pages across the cellars; the counts cover all of them, an unknown reason as other', async () => {
    const { body } = await request(`/api/cellars/multi/history?cellars=${CELLAR_ID},${CELLAR_2}&limit=2`);
    expect(ids(body.bottles)).toEqual([id(12), id(14)]);
    expect(body.total).toBe(5);
    expect(body.reasonCounts).toEqual({ drank: 3, gifted: 1, sold: 0, other: 1 });

    const next = await request(`/api/cellars/multi/history?cellars=${CELLAR_ID},${CELLAR_2}&limit=2&skip=2`);
    expect(ids(next.body.bottles)).toEqual([id(13), id(15)]);
  });

  test('without ?limit: every bottle, as before', async () => {
    const { body } = await request(`/api/cellars/multi/history?cellars=${CELLAR_ID},${CELLAR_2}`);
    expect(body.bottles).toHaveLength(5);
    expect(body.total).toBe(5);
  });
});
