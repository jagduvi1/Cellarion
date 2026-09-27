/**
 * GET /api/cellars/:id/history and /multi/history — paged with ?limit.
 *
 * WHY THIS TEST EXISTS:
 * The history page used to receive and render every consumed bottle at once
 * (up to 10,000); a history imported from another app can hold thousands.
 * With ?limit the routes send one page, newest-consumed first, with the total
 * and the per-reason counts the page's summary shows. The page lists bottles
 * in sections (drank, gifted, sold, other), so a section's next page is asked
 * for with ?reason and ?before (its last bottle): it continues after that
 * bottle's place in the order, so bottles consumed or restored between two
 * pages can't make it repeat or skip any. Without ?limit the whole history
 * comes back as before, now with the same totals.
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
// A section's cursor, as the page builds it from its last bottle.
const after = (n, d) => encodeURIComponent(`${d ? day(d).toISOString() : ''}|${id(n)}`);

// The single cellar's history, newest first: 16 and 12 share a date (the
// newer _id first), 17 has no date (last).
//   16 drank d5 · 12 drank d5 · 13 gifted d3 · 15 drank d2 · 11 drank d1 · 17 sold —
// CELLAR_2 adds 14 (other, d4).
const INITIAL_ROWS = [
  { _id: id(11), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(1) },
  { _id: id(12), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(5), rating: 5, ratingScale: '5' },
  { _id: id(13), cellar: CELLAR_ID, status: 'gifted', consumedReason: 'gifted', consumedAt: day(3) },
  { _id: id(14), cellar: CELLAR_2, status: 'other', consumedReason: 'broken', consumedAt: day(4), rating: 5, ratingScale: '5' }, // unknown reason → other
  { _id: id(15), cellar: CELLAR_ID, status: 'drank', consumedReason: null, consumedAt: day(2) }, // no reason → its status
  { _id: id(16), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(5), rating: 5, ratingScale: '5' },
  { _id: id(17), cellar: CELLAR_ID, status: 'sold', consumedReason: 'sold', consumedAt: null },
];
let ROWS;

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

// MongoDB's { consumedAt: -1, _id: -1 }: no date sorts last.
const mongoOrder = (a, b) => {
  const at = a.consumedAt ? a.consumedAt.getTime() : -Infinity;
  const bt = b.consumedAt ? b.consumedAt.getTime() : -Infinity;
  return bt - at || (a._id < b._id ? 1 : -1);
};

// An in-memory Bottle.find: filter by cellar / _id / status, then sort, skip, limit.
let finds = [];
function bottleQuery(filter) {
  const record = { filter, select: null, sort: null, skip: 0, limit: Infinity };
  finds.push(record);
  const matches = (r) => {
    if (filter.user) return false; // sibling-photo lookup
    if (filter._id && filter._id.$in) return filter._id.$in.map(String).includes(r._id);
    const cellars = filter.cellar && filter.cellar.$in ? filter.cellar.$in.map(String) : [String(filter.cellar)];
    return cellars.includes(r.cellar);
  };
  const q = {
    populate: () => q,
    select: (s) => { record.select = s; return q; },
    sort: (s) => { record.sort = s; return q; },
    skip: (n) => { record.skip = n; return q; },
    limit: (n) => { record.limit = n; return q; },
    lean: async () => {
      let rows = ROWS.filter(matches).map((r) => ({ ...r }));
      if (record.sort && record.sort.consumedAt) rows.sort(mongoOrder);
      return rows.slice(record.skip, record.skip + record.limit);
    },
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  finds = [];
  ROWS = INITIAL_ROWS.map((r) => ({ ...r }));
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
  bottleSearch.bottleFacets.mockResolvedValue({ facetDistribution: { type: {} }, baseFacetDistribution: {}, facetMeta: {} });
});

const ids = (bottles) => bottles.map((b) => b._id);
const single = (query) => request(`/api/cellars/${CELLAR_ID}/history?${query}`);
const multi = (query) => request(`/api/cellars/multi/history?cellars=${CELLAR_ID},${CELLAR_2}&${query}`);

describe('GET /api/cellars/:id/history', () => {
  test('?limit: the newest page, the total and per-reason counts of the whole history, and the facets', async () => {
    const { status, body } = await single('limit=2');
    expect(status).toBe(200);
    expect(ids(body.bottles)).toEqual([id(16), id(12)]);
    expect(body.total).toBe(6);
    expect(body.reasonCounts).toEqual({ drank: 4, gifted: 1, sold: 1, other: 0 });
    expect(body.remaining).toBe(4);
    expect(body.facets).toEqual({ type: {} });
    // Every bottle's order and reason come from four fields, in MongoDB's
    // order with _id breaking ties; only the page is loaded in full.
    expect(finds[0].select).toBe('_id consumedAt consumedReason status');
    expect(finds[0].sort).toEqual({ consumedAt: -1, _id: -1 });
    expect(finds[1].filter._id.$in.map(String)).toEqual([id(16), id(12)]);
  });

  test('a section pages after its last bottle, with the same date broken by _id, and skips the facets', async () => {
    const first = await single(`limit=2&reason=drank&before=${after(16, 5)}`);
    expect(ids(first.body.bottles)).toEqual([id(12), id(15)]);
    expect(first.body.remaining).toBe(1);
    expect(first.body.total).toBe(6);

    const last = await single(`limit=2&reason=drank&before=${after(15, 2)}`);
    expect(ids(last.body.bottles)).toEqual([id(11)]);
    expect(last.body.remaining).toBe(0);

    // A section's first page (nothing of it loaded yet) has no cursor.
    const sold = await single('limit=2&reason=sold');
    expect(ids(sold.body.bottles)).toEqual([id(17)]);
    // After a bottle without a date: only others without one, older _id first.
    const none = await single(`limit=2&reason=sold&before=${after(17)}`);
    expect(none.body.bottles).toEqual([]);
    expect(none.body.remaining).toBe(0);

    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
    expect(first.body.facets).toBeUndefined();
  });

  test('bottles consumed or restored between two pages neither repeat nor skip a bottle', async () => {
    const first = await single('limit=2');
    expect(ids(first.body.bottles)).toEqual([id(16), id(12)]);

    // Meanwhile: 16 is restored to the cellar, and a new bottle is drunk.
    ROWS = ROWS.filter((r) => r._id !== id(16));
    ROWS.push({ _id: id(18), cellar: CELLAR_ID, status: 'drank', consumedReason: 'drank', consumedAt: day(9) });

    const next = await single(`limit=2&reason=drank&before=${after(12, 5)}`);
    expect(ids(next.body.bottles)).toEqual([id(15), id(11)]);
  });

  test('the whole list pages after a cursor too; a cursor that makes no sense starts at the top', async () => {
    const { body } = await single(`limit=10&before=${after(16, 5)}`);
    expect(ids(body.bottles)).toEqual([id(12), id(13), id(15), id(11), id(17)]);

    const bad = await single('limit=1&reason=gifted&before=yesterday');
    expect(ids(bad.body.bottles)).toEqual([id(13)]);
  });

  test('a search pages its own hits, newest-consumed first', async () => {
    bottleSearch.searchBottles.mockResolvedValue({
      ids: [id(11), id(13)], total: 2, facetDistribution: {}, baseFacetDistribution: {}, facetMeta: {},
    });
    const { body } = await single('search=x&limit=1');
    expect(ids(body.bottles)).toEqual([id(13)]);
    expect(body.total).toBe(2);
    expect(body.reasonCounts).toEqual({ drank: 1, gifted: 1, sold: 0, other: 0 });
  });

  test('without ?limit: the whole history, as before, with the same totals', async () => {
    const { body } = await request(`/api/cellars/${CELLAR_ID}/history`);
    expect(ids(body.bottles)).toEqual([id(16), id(12), id(13), id(15), id(11), id(17)]);
    expect(body.total).toBe(6);
    expect(body.reasonCounts).toEqual({ drank: 4, gifted: 1, sold: 1, other: 0 });
    expect(body.remaining).toBeUndefined();
  });
});

describe('GET /api/cellars/multi/history', () => {
  test('?limit pages across the cellars from four fields per bottle; the counts cover all of them', async () => {
    const { body } = await multi('limit=2');
    expect(ids(body.bottles)).toEqual([id(16), id(12)]);
    expect(body.total).toBe(7);
    expect(body.reasonCounts).toEqual({ drank: 4, gifted: 1, sold: 1, other: 1 });
    expect(body.remaining).toBe(5);
    expect(body.facets).toEqual({ type: {} });
    expect(finds[0].select).toBe('_id consumedAt consumedReason status');
    expect(finds[0].sort).toEqual({ consumedAt: -1, _id: -1 });
    expect(finds[1].filter._id.$in.map(String)).toEqual([id(16), id(12)]);
    // Each bottle says which cellar it is in.
    expect(body.bottles[0].cellarName).toBe('Home');
  });

  test('a section\'s next page, without recounting the facets', async () => {
    const { body } = await multi(`limit=2&reason=other&before=${after(12, 5)}`);
    expect(ids(body.bottles)).toEqual([id(14)]);
    expect(body.remaining).toBe(0);
    expect(body.facets).toBeUndefined();
    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
  });

  test('with a rating filter (whole bottles): the same order, sections and cursor', async () => {
    const first = await multi('limit=1&minRating=90');
    expect(ids(first.body.bottles)).toEqual([id(16)]);
    expect(first.body.total).toBe(3);
    expect(first.body.reasonCounts).toEqual({ drank: 2, gifted: 0, sold: 0, other: 1 });

    const next = await multi(`limit=5&reason=drank&before=${after(16, 5)}&minRating=90`);
    expect(ids(next.body.bottles)).toEqual([id(12)]);
    expect(next.body.remaining).toBe(0);
  });

  test('without ?limit: every bottle, newest first with _id breaking ties, as before', async () => {
    const { body } = await request(`/api/cellars/multi/history?cellars=${CELLAR_ID},${CELLAR_2}`);
    expect(ids(body.bottles)).toEqual([id(16), id(12), id(14), id(13), id(15), id(11), id(17)]);
    expect(body.total).toBe(7);
  });
});
