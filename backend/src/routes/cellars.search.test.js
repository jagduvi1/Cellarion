/**
 * The cellar routes' search wiring — GET /api/cellars/:id, /:id/history and
 * /multi/bottles on services/bottleSearch (which has its own tests; mocked
 * here). Pinned: what each route asks the search, that the ranked order
 * survives hydration, and that one search pass also supplies the filter
 * modal's facets (a plain page counts them with one grouping query instead).
 *
 * Real router + real requireAuth (HS256 test token); models are mocked so no
 * MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/openBottleList', () => ({ listOpenBottles: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn(),
}));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
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
const Rack = require('../models/Rack');
const BottleImage = require('../models/BottleImage');
const bottleSearch = require('../services/bottleSearch');
const { listOpenBottles } = require('../services/openBottleList');
const cellarsRouter = require('./cellars');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000c1';
const CELLAR_2 = '64b0000000000000000000c2';
const RACK_ID = '64b0000000000000000000a1';
const B1 = '64b0000000000000000000b1';
const B2 = '64b0000000000000000000b2';
const B3 = '64b0000000000000000000b3';

function request(url) {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port,
        path: url,
        method: 'GET',
        headers: {
          authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const bottleRow = (id, extra = {}) => ({
  _id: id, cellar: CELLAR_ID, user: USER_ID, status: 'active', vintage: '2015', wineDefinition: null, ...extra,
});
const ROWS = {
  [B1]: bottleRow(B1, { consumedAt: new Date('2026-01-01'), status: 'drank' }),
  [B2]: bottleRow(B2, { consumedAt: new Date('2026-03-01'), status: 'drank' }),
  [B3]: bottleRow(B3),
};
const LIST = [ROWS[B3]];

// One query chain for every Bottle.find shape the routes use. Hydration by id
// answers in REVERSE, so a test can see the route restore the ranked order.
// Every hydration by id is recorded (ids asked for, populate used).
let loads = [];
function bottleQuery(filter) {
  let rows;
  const load = filter && filter._id && filter._id.$in ? { ids: filter._id.$in.map(String), populate: null } : null;
  if (load) loads.push(load);
  if (filter && filter._id && filter._id.$in) {
    rows = filter._id.$in.map((id) => ROWS[String(id)]).filter(Boolean).reverse();
  } else if (filter && filter.user) {
    rows = []; // sibling-photo lookup in attachBottleImageUrls
  } else {
    rows = LIST;
  }
  const q = {
    populate: (spec) => { if (load) load.populate = spec; return q; }, sort: () => q, skip: () => q, limit: () => q, select: () => q,
    lean: async () => rows.map((r) => ({ ...r })),
  };
  return q;
}

// hits: what the search returns with withHits (routes page over them). By
// default every bottle is a wine of its own; pass wines to share one.
const FOUND = (ids, wines = {}) => ({
  ids,
  hits: ids.map((id) => ({ id, wineDefinition: wines[id] || null, vintage: '2015', bottleSize: undefined })),
  total: ids.length,
  facetDistribution: { type: { red: ids.length } },
  baseFacetDistribution: { type: { red: 3, white: 1 } },
  facetMeta: { countries: {}, regions: {}, grapes: {} },
});
const PLAIN_FACETS = {
  facetDistribution: { type: { red: 9 } },
  baseFacetDistribution: { type: { red: 9 } },
  facetMeta: { countries: { France: 'x' }, regions: {}, grapes: {} },
};

beforeEach(() => {
  jest.clearAllMocks();
  loads = [];
  const cellar = { _id: CELLAR_ID, name: 'Home', user: { _id: USER_ID, username: 'me' }, members: [], deletedAt: null, userColors: [] };
  Cellar.findById.mockImplementation(() => ({
    populate: () => {
      const doc = Promise.resolve({ ...cellar, toObject: () => ({ ...cellar }) });
      doc.lean = async () => ({ ...cellar });
      return doc;
    },
  }));
  Cellar.find.mockReturnValue({
    lean: async () => [
      { ...cellar, _id: CELLAR_ID, user: USER_ID },
      { ...cellar, _id: CELLAR_2, user: USER_ID },
    ],
  });
  Bottle.find.mockImplementation(bottleQuery);
  Bottle.countDocuments.mockResolvedValue(LIST.length);
  const imageChain = { sort: () => imageChain, lean: async () => [] };
  BottleImage.find.mockReturnValue(imageChain);
  bottleSearch.bottleFacets.mockResolvedValue(PLAIN_FACETS);
  listOpenBottles.mockResolvedValue([]);
});

const idsOf = (items) => items.map((b) => String(b._id));

describe('GET /api/cellars/:id', () => {
  test('a search asks bottleSearch for this cellar, keeps its ranking and ships its facets', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B1]));

    const { status, body } = await request(`/api/cellars/${CELLAR_ID}?search=barollo&sort=-createdAt`);

    expect(status).toBe(200);
    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('barollo', expect.objectContaining({
      cellarId: CELLAR_ID, sort: '-createdAt', limit: 10000, offset: 0,
    }));
    expect(idsOf(body.bottles.items)).toEqual([B2, B1]);
    expect(body.bottles.total).toBe(2);
    expect(body.facets).toEqual({ type: { red: 2 } });
    expect(body.baseFacets).toEqual({ type: { red: 3, white: 1 } });
    expect(body.facetMeta).toEqual(FOUND([]).facetMeta);
    // One pass: no second query for the facets.
    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
  });

  test('wine filters without text go through the search too', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B1]));

    await request(`/api/cellars/${CELLAR_ID}?type=red,white&vintage=2015&appellation=Barolo`);

    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('', expect.objectContaining({
      cellarId: CELLAR_ID, type: 'red,white', vintage: '2015', appellation: 'Barolo',
    }));
  });

  test('a plain page never searches — its facets come from one grouping query', async () => {
    const { status, body } = await request(`/api/cellars/${CELLAR_ID}`);

    expect(status).toBe(200);
    expect(bottleSearch.searchBottles).not.toHaveBeenCalled();
    expect(bottleSearch.bottleFacets).toHaveBeenCalledTimes(1);
    expect(bottleSearch.bottleFacets).toHaveBeenCalledWith({ cellarId: CELLAR_ID });
    expect(idsOf(body.bottles.items)).toEqual([B3]);
    expect(body.facets).toEqual(PLAIN_FACETS.facetDistribution);
    expect(body.facetMeta).toEqual(PLAIN_FACETS.facetMeta);
  });

  test('no hits is a normal answer — the modal still gets every option to change the filters', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([]));

    const { status, body } = await request(`/api/cellars/${CELLAR_ID}?search=xyzzy`);

    expect(status).toBe(200);
    expect(body.bottles).toMatchObject({ total: 0, count: 0, items: [] });
    expect(body.baseFacets).toEqual({ type: { red: 3, white: 1 } });
    expect(body.facetMeta).toBeDefined();
  });

  test('a rack filter narrows the hits, and sends no counts it cannot scope (audit 2026-09-07)', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B1]));
    Rack.find.mockReturnValue({ select: () => ({ lean: async () => [{ slots: [{ bottle: B1 }] }] }) });

    const { body } = await request(`/api/cellars/${CELLAR_ID}?search=x&rack=${RACK_ID}`);

    expect(idsOf(body.bottles.items)).toEqual([B1]);
    expect(body).not.toHaveProperty('facets');
  });
});

describe('GET /api/cellars/:id/history', () => {
  test('a search runs on consumed bottles and the list stays newest-consumed first', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B1, B2]));

    const { status, body } = await request(`/api/cellars/${CELLAR_ID}/history?search=pinot`);

    expect(status).toBe(200);
    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('pinot', expect.objectContaining({
      cellarId: CELLAR_ID, statusFilter: 'consumed',
    }));
    expect(idsOf(body.bottles)).toEqual([B2, B1]); // March before January, not relevance
    expect(body.facets).toEqual({ type: { red: 2 } });
    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
  });

  test('without a search: the history list, facets from the grouping query', async () => {
    const { body } = await request(`/api/cellars/${CELLAR_ID}/history`);

    expect(bottleSearch.searchBottles).not.toHaveBeenCalled();
    expect(bottleSearch.bottleFacets).toHaveBeenCalledWith({ cellarId: CELLAR_ID, statusFilter: 'consumed' });
    expect(body.baseFacets).toEqual(PLAIN_FACETS.baseFacetDistribution);
  });
});

describe('GET /api/cellars/multi/bottles', () => {
  test('searches exactly the accessible cellars, and the first page reuses the search\'s facets', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B1]));

    const { status, body } = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID},${CELLAR_2}&search=margaux`);

    expect(status).toBe(200);
    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('margaux', expect.objectContaining({
      cellarIds: [CELLAR_ID, CELLAR_2], statusFilter: 'active',
    }));
    expect(idsOf(body.bottles.items)).toEqual([B2, B1]);
    expect(body.facets).toEqual({ type: { red: 2 } });
    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
  });

  test('later pages skip the facets entirely', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B1]));

    const { body } = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID}&search=margaux&skip=30`);

    expect(body.facets).toBeNull();
    expect(bottleSearch.bottleFacets).not.toHaveBeenCalled();
  });
});

// ── Only the page is loaded (scaling audit 2026-09-25, item 10) ──────────────
// A search used to load and populate every hit (a big cellar: ~800 bottles,
// ~4 MB) to show 30. With nothing left to filter in memory, the route pages
// over the search's hits and loads just the page's bottles.

describe('GET /api/cellars/:id — only the page is loaded', () => {
  const { WINE_POPULATE_CARDS } = require('../config/constants');
  const W1 = '64b0000000000000000000f1';

  test('grouped: groups in rank order from the hits; only the page\'s members are loaded, with the card populate', async () => {
    // B2 and B1 are one wine and vintage (one group), B3 its own.
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1], { [B2]: W1, [B1]: W1 }));

    const first = await request(`/api/cellars/${CELLAR_ID}?search=x&group=1&limit=1`);
    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('x', expect.objectContaining({ withHits: true }));
    expect(first.body.bottles.total).toBe(2); // groups
    // …and the bottles in them, for the filter's "Show n bottles".
    expect(first.body.bottles.bottleTotal).toBe(3);
    expect(first.body.bottles.items).toHaveLength(1);
    expect(first.body.bottles.items[0]).toMatchObject({ key: `${W1}::2015::750ml`, count: 2 });
    expect(idsOf(first.body.bottles.items[0].bottles)).toEqual([B2, B1]);
    expect(loads[0].ids).toEqual([B2, B1]); // not B3
    expect(loads[0].populate).toBe(WINE_POPULATE_CARDS);

    loads = [];
    const second = await request(`/api/cellars/${CELLAR_ID}?search=x&group=1&limit=1&skip=1`);
    expect(second.body.bottles.items[0]).toMatchObject({ key: `none:${B3}::2015::750ml`, count: 1 });
    expect(loads[0].ids).toEqual([B3]);
  });

  test('flat: only the page\'s ids are loaded, in rank order; total counts every hit', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1]));

    const { body } = await request(`/api/cellars/${CELLAR_ID}?search=x&limit=2&skip=1`);

    expect(body.bottles.total).toBe(3);
    expect(body.bottles.bottleTotal).toBeUndefined(); // flat: total is bottles
    expect(idsOf(body.bottles.items)).toEqual([B3, B1]);
    expect(loads[0].ids).toEqual([B3, B1]);
  });

  test('a filter applied in memory (rating) still loads every hit first', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1]));

    await request(`/api/cellars/${CELLAR_ID}?search=x&minRating=4`);

    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('x', expect.objectContaining({ withHits: false }));
    expect(loads[0].ids).toEqual([B2, B3, B1]);
  });

  test('bottles excluded by the caller never reach the page', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1]));

    const { body } = await request(`/api/cellars/${CELLAR_ID}?search=x&exclude=${B3}`);

    expect(idsOf(body.bottles.items)).toEqual([B2, B1]);
    expect(body.bottles.total).toBe(2);
  });
});

describe('GET /api/cellars/multi/bottles — only the page is loaded', () => {
  test('a search page loads only its own bottles; total counts every hit', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1]));

    const { body } = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID}&search=m&limit=1&skip=1`);

    expect(body.bottles.total).toBe(3);
    expect(idsOf(body.bottles.items)).toEqual([B3]);
    expect(loads[0].ids).toEqual([B3]);
  });

  test('a sort the route applies itself (name) still loads every hit', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B3, B1]));

    await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID}&search=m&sort=name`);

    expect(loads[0].ids).toEqual([B2, B3, B1]);
  });
});

// ── Sort by quantity (forum request 2026-10-15) ─────────────────────────────
// The grouped list's cards by how many identical bottles each holds; the
// search's ranking can't do that, so every hit is loaded and the cards are
// counted.
describe('GET /api/cellars/:id?sort=-quantity — cards by how many bottles they hold', () => {
  const W1 = '64b0000000000000000000f1';
  const saved = { ...ROWS };
  beforeEach(() => {
    ROWS[B1] = bottleRow(B1, { wineDefinition: { _id: W1, name: 'Barolo' } });
    ROWS[B2] = bottleRow(B2, { wineDefinition: { _id: W1, name: 'Barolo' } });
    ROWS[B3] = bottleRow(B3, { wineDefinition: { _id: '64b0000000000000000000f3', name: 'Albariño' } });
  });
  afterAll(() => Object.assign(ROWS, saved));

  test('most first, fewest first — whatever the search ranked first', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B3, B1, B2], { [B1]: W1, [B2]: W1 }));

    const most = await request(`/api/cellars/${CELLAR_ID}?search=x&group=1&sort=-quantity`);
    expect(most.body.bottles.items.map((g) => g.count)).toEqual([2, 1]);
    expect(most.body.bottles.items[0].key).toBe(`${W1}::2015::750ml`);
    expect(most.body.bottles.bottleTotal).toBe(3);
    // Grouped, the hits themselves are counted: only the page is loaded.
    expect(bottleSearch.searchBottles).toHaveBeenCalledWith('x', expect.objectContaining({ withHits: true }));

    const fewest = await request(`/api/cellars/${CELLAR_ID}?search=x&group=1&sort=quantity`);
    expect(fewest.body.bottles.items.map((g) => g.count)).toEqual([1, 2]);
  });

  test('the "all my cellars" view sorts its cards the same way', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B3, B1, B2], { [B1]: W1, [B2]: W1 }));
    const most = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID}&search=x&group=1&sort=-quantity`);
    expect(most.status).toBe(200);
    expect(most.body.bottles.items.map((g) => g.count)).toEqual([2, 1]);
    const fewest = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID}&search=x&group=1&sort=quantity`);
    expect(fewest.body.bottles.items.map((g) => g.count)).toEqual([1, 2]);
  });
});

// The default cellar page sorted by quantity (no search, no filters): the
// groups are counted in MongoDB and only the page's bottles are loaded —
// not the whole cellar. Cards holding as many: A to Z by the wine's name.
describe('GET /api/cellars/:id?group=1&sort=-quantity — counted in the database', () => {
  const WineDefinition = require('../models/WineDefinition');
  const W1 = '64b0000000000000000000f1';
  const W2 = '64b0000000000000000000f2';
  const W3 = '64b0000000000000000000f3';
  const oid = (h) => new (require('mongoose').Types.ObjectId)(h);
  const saved = { ...ROWS };
  beforeEach(() => {
    ROWS[B1] = bottleRow(B1, { wineDefinition: { _id: W1, name: 'Zinfandel' } });
    ROWS[B2] = bottleRow(B2, { wineDefinition: { _id: W2, name: 'Barolo' } });
    ROWS[B3] = bottleRow(B3, { wineDefinition: { _id: W3, name: 'Albariño' } });
  });
  afterAll(() => Object.assign(ROWS, saved));

  test('cards by size from one grouping query; ties A to Z; only the page is loaded', async () => {
    let pipeline;
    Bottle.aggregate.mockImplementation((p) => {
      pipeline = p;
      return { allowDiskUse: async () => [
        { _id: { wine: oid(W1), vintage: '2015', size: '750ml' }, n: 1, wineRef: oid(W1), memberIds: [oid(B1)] },
        { _id: { wine: oid(W2), vintage: '2015', size: '750ml' }, n: 1, wineRef: oid(W2), memberIds: [oid(B2)] },
        { _id: { wine: oid(W3), vintage: '2015', size: '750ml' }, n: 4, wineRef: oid(W3), memberIds: [oid(B3)] },
      ] };
    });
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: async () => [
      { _id: oid(W1), name: 'Zinfandel' }, { _id: oid(W2), name: 'Barolo' }, { _id: oid(W3), name: 'Albariño' },
    ] }) });
    const { status, body } = await request(`/api/cellars/${CELLAR_ID}?group=1&sort=-quantity&limit=2`);
    expect(status).toBe(200);
    // The size is counted in the $group; no bottle documents for that.
    expect(pipeline.find((st) => st.$group).$group.n).toEqual({ $sum: 1 });
    expect(body.bottles.total).toBe(3);
    expect(body.bottles.bottleTotal).toBe(6);
    // 4 first, then the two singles A to Z (Barolo before Zinfandel); page of 2.
    expect(body.bottles.items.map((g) => g.key)).toEqual([`${W3}::2015::750ml`, `${W2}::2015::750ml`]);
    expect(loads.map((l) => l.ids).flat().sort()).toEqual([B2, B3].sort());
  });

  // Release audit 2026-10-16: one wine and vintage in two sizes, as many of
  // each — the order no longer depends on the order MongoDB groups in, so a
  // page boundary never shows one card twice and the other not at all.
  test('cards that differ only in size keep one order whatever order the groups come in', async () => {
    ROWS[B2] = bottleRow(B2, { wineDefinition: { _id: W1, name: 'Zinfandel' }, bottleSize: '1500ml' });
    const groups = [
      { _id: { wine: oid(W1), vintage: '2015', size: '750ml' }, n: 2, wineRef: oid(W1), memberIds: [oid(B1)] },
      { _id: { wine: oid(W1), vintage: '2015', size: '1500ml' }, n: 2, wineRef: oid(W1), memberIds: [oid(B2)] },
    ];
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: oid(W1), name: 'Zinfandel' }] }) });
    const orders = [];
    for (const answer of [groups, [...groups].reverse()]) {
      Bottle.aggregate.mockImplementation(() => ({ allowDiskUse: async () => answer.map((g) => ({ ...g })) }));
      const { body } = await request(`/api/cellars/${CELLAR_ID}?group=1&sort=-quantity`);
      orders.push(body.bottles.items.map((g) => g.key));
    }
    expect(orders[0]).toEqual(orders[1]);
    expect(orders[0]).toEqual([`${W1}::2015::1500ml`, `${W1}::2015::750ml`]);
  });
});

// The default cellar page in an order MongoDB can sort (newest first, vintage,
// price, rating; no search, no filters): the cards are grouped AND paged in
// the database — one pipeline for the page, one for the totals — and only the
// page's bottles are loaded, never the whole cellar.
describe('GET /api/cellars/:id?group=1 — the default page, grouped and paged in the database', () => {
  const { NOT_IN_CELLAR_STATUSES } = require('../config/constants');
  const W1 = '64b0000000000000000000f1';
  const GONE = '64b0000000000000000000b9';
  const oid = (h) => new (require('mongoose').Types.ObjectId)(h);
  const saved = { ...ROWS };
  beforeEach(() => {
    ROWS[B1] = bottleRow(B1, { wineDefinition: { _id: W1, name: 'Zinfandel' } });
    ROWS[B2] = bottleRow(B2, { wineDefinition: { _id: W1, name: 'Zinfandel' } });
    ROWS[B3] = bottleRow(B3);
  });
  afterAll(() => Object.assign(ROWS, saved));

  // The page pipeline ends in $skip and $limit; the other one counts.
  const isPage = (p) => p.some((st) => st.$limit !== undefined);
  let pipelines;
  const groupedAnswers = (pageGroups, totals) => {
    pipelines = [];
    Bottle.aggregate.mockImplementation((p) => {
      pipelines.push(p);
      return { allowDiskUse: async () => (isPage(p) ? pageGroups : [totals]) };
    });
  };
  const TWO_CARDS = [
    { _id: { wine: oid(W1), vintage: '2015', size: '750ml' }, sortVal: new Date('2026-02-01'), wineRef: oid(W1), memberIds: [oid(B1), oid(B2)] },
    // No wine: the bottle is a card of its own, keyed by its own id.
    { _id: { wine: oid(B3), vintage: 'NV', size: '750ml' }, sortVal: new Date('2026-01-01'), wineRef: null, memberIds: [oid(B3)] },
  ];

  test('one pipeline pages the cards, one counts them; only the page is loaded', async () => {
    groupedAnswers(TWO_CARDS, { _id: null, total: 7, bottles: 12 });

    const { status, body } = await request(`/api/cellars/${CELLAR_ID}?group=1&limit=2&skip=4`);

    expect(status).toBe(200);
    expect(pipelines).toHaveLength(2);
    const page = pipelines.find(isPage);
    expect(page[0]).toEqual({ $match: { cellar: oid(CELLAR_ID), status: { $nin: NOT_IN_CELLAR_STATUSES } } });
    expect(page[1]).toEqual({ $sort: { createdAt: -1 } });
    // A card: one wine, vintage and size. No vintage reads NV, no size 750ml.
    expect(page[2].$group).toEqual({
      _id: {
        wine: { $ifNull: ['$wineDefinition', '$_id'] },
        vintage: { $let: { vars: { v: { $ifNull: ['$vintage', 'NV'] } }, in: { $cond: [{ $eq: ['$$v', ''] }, 'NV', '$$v'] } } },
        size: { $let: { vars: { v: { $ifNull: ['$bottleSize', '750ml'] } }, in: { $cond: [{ $eq: ['$$v', ''] }, '750ml', '$$v'] } } },
      },
      sortVal: { $first: '$createdAt' },
      wineRef: { $first: '$wineDefinition' },
      memberIds: { $push: '$_id' },
    });
    // The card's id breaks a tie, so tied cards keep one order from page to page.
    expect(page.slice(3)).toEqual([{ $sort: { sortVal: -1, _id: 1 } }, { $skip: 4 }, { $limit: 2 }]);

    const count = pipelines.find((p) => !isPage(p));
    expect(count[0]).toEqual(page[0]);
    expect(count[1].$group._id).toEqual(page[2].$group._id);
    expect(count[2]).toEqual({ $group: { _id: null, total: { $sum: 1 }, bottles: { $sum: '$n' } } });

    expect(body.bottles.total).toBe(7);
    expect(body.bottles.bottleTotal).toBe(12);
    expect(body.bottles.items.map((g) => g.key)).toEqual([`${W1}::2015::750ml`, `none:${B3}::NV::750ml`]);
    expect(body.bottles.items.map((g) => g.count)).toEqual([2, 1]);
    expect(idsOf(body.bottles.items[0].bottles)).toEqual([B1, B2]);
    // One load, of the page's three bottles.
    expect(loads.filter((l) => l.populate)).toHaveLength(1);
    expect(loads.find((l) => l.populate).ids.sort()).toEqual([B1, B2, B3].sort());
    expect(bottleSearch.searchBottles).not.toHaveBeenCalled();
  });

  test('the order asked for is the order MongoDB sorts and breaks ties in', async () => {
    groupedAnswers(TWO_CARDS, { _id: null, total: 2, bottles: 3 });

    await request(`/api/cellars/${CELLAR_ID}?group=1&sort=vintage`);

    const page = pipelines.find(isPage);
    expect(page[1]).toEqual({ $sort: { vintage: 1 } });
    expect(page[2].$group.sortVal).toEqual({ $first: '$vintage' });
    expect(page.slice(3)).toEqual([{ $sort: { sortVal: 1, _id: 1 } }, { $skip: 0 }, { $limit: 30 }]);
  });

  test('bottles to leave out, and a rack to stay inside, narrow both pipelines', async () => {
    groupedAnswers(TWO_CARDS, { _id: null, total: 2, bottles: 3 });
    await request(`/api/cellars/${CELLAR_ID}?group=1&exclude=${B3}`);
    expect(pipelines.map((p) => p[0].$match._id)).toEqual([{ $nin: [oid(B3)] }, { $nin: [oid(B3)] }]);

    Rack.find.mockReturnValueOnce({ select: () => ({ lean: async () => [{ slots: [{ bottle: oid(B1) }, { bottle: oid(B2) }] }] }) });
    groupedAnswers(TWO_CARDS, { _id: null, total: 1, bottles: 2 });
    await request(`/api/cellars/${CELLAR_ID}?group=1&rack=${RACK_ID}`);
    expect(pipelines.map((p) => p[0].$match._id)).toEqual([{ $in: [oid(B1), oid(B2)] }, { $in: [oid(B1), oid(B2)] }]);
  });

  test('a card whose bottles are gone by the time they are loaded is left out', async () => {
    groupedAnswers([
      { _id: { wine: oid(W1), vintage: '2015', size: '750ml' }, sortVal: 1, wineRef: oid(W1), memberIds: [oid(B1), oid(GONE)] },
      { _id: { wine: oid(GONE), vintage: 'NV', size: '750ml' }, sortVal: 0, wineRef: null, memberIds: [oid(GONE)] },
    ], { _id: null, total: 2, bottles: 3 });

    const { body } = await request(`/api/cellars/${CELLAR_ID}?group=1`);

    expect(body.bottles.items.map((g) => [g.key, g.count])).toEqual([[`${W1}::2015::750ml`, 1]]);
  });

  test('a filter the database cannot apply takes the other path: no grouping pipeline', async () => {
    groupedAnswers(TWO_CARDS, { _id: null, total: 2, bottles: 3 });

    const { status } = await request(`/api/cellars/${CELLAR_ID}?group=1&reserved=1`);

    expect(status).toBe(200);
    expect(pipelines).toHaveLength(0);
  });
});

// The cross-cellar list without a search. In an order MongoDB can sort, with
// nothing to filter in memory, the page is cut in the database. A rating,
// maturity or chart filter, or an order MongoDB cannot sort, loads the set
// (capped) and filters, sorts and pages it in memory.
describe('GET /api/cellars/multi/bottles — without a search', () => {
  const { NOT_IN_CELLAR_STATUSES } = require('../config/constants');
  const oid = (h) => new (require('mongoose').Types.ObjectId)(h);
  const YEAR = new Date().getFullYear();
  const savedRows = { ...ROWS };
  const savedList = [...LIST];
  afterEach(() => {
    Object.assign(ROWS, savedRows);
    LIST.splice(0, LIST.length, ...savedList);
  });
  const listIs = (...rows) => LIST.splice(0, LIST.length, ...rows);

  // What each Bottle.find was asked, on top of the suite's query chain.
  let asked;
  beforeEach(() => {
    asked = [];
    Bottle.find.mockImplementation((filter) => {
      const q = bottleQuery(filter);
      const call = { filter };
      asked.push(call);
      for (const step of ['sort', 'skip', 'limit']) q[step] = (arg) => { call[step] = arg; return q; };
      return q;
    });
  });
  // The list queries: the ones over a cellar set (not the photo lookups).
  const listQueries = () => asked.filter((c) => c.filter.cellar);
  const SET = { cellar: { $in: [oid(CELLAR_ID), oid(CELLAR_2)] }, status: { $nin: NOT_IN_CELLAR_STATUSES } };
  const both = (query = '') => request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID},${CELLAR_2}${query}`);

  test('the default view is cut in the database: one page query, one count, the facets from one grouping query', async () => {
    Bottle.countDocuments.mockResolvedValue(41);

    const { status, body } = await both('&limit=5');

    expect(status).toBe(200);
    expect(listQueries()).toEqual([{ filter: SET, sort: { createdAt: -1 }, skip: 0, limit: 5 }]);
    expect(Bottle.countDocuments).toHaveBeenCalledWith(SET);
    expect(body.bottles).toMatchObject({ count: 1, total: 41, limit: 5, skip: 0, grouped: false });
    expect(idsOf(body.bottles.items)).toEqual([B3]);
    // Each bottle says which cellar it lies in.
    expect(body.bottles.items[0]).toMatchObject({ cellarName: 'Home', cellarColor: null });
    expect(body.cellars).toEqual([
      { _id: CELLAR_ID, name: 'Home', userColor: null },
      { _id: CELLAR_2, name: 'Home', userColor: null },
    ]);
    expect(bottleSearch.searchBottles).not.toHaveBeenCalled();
    expect(bottleSearch.bottleFacets).toHaveBeenCalledWith({ cellarIds: [CELLAR_ID, CELLAR_2], statusFilter: 'active' });
    expect(body.facets).toEqual(PLAIN_FACETS.facetDistribution);
  });

  test('the order and the page asked for go to the database', async () => {
    await both('&sort=-price&limit=5&skip=10');

    expect(listQueries()).toEqual([{ filter: SET, sort: { price: -1 }, skip: 10, limit: 5 }]);
  });

  test('only cellars the user can read are listed: another one is dropped, none left is a 403, no id a 400', async () => {
    const OTHER = '64b0000000000000000000c9';

    const { status } = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID},${OTHER},junk`);

    expect(status).toBe(200);
    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: USER_ID }, { 'members.user': USER_ID }], deletedAt: null });
    expect(listQueries()[0].filter.cellar).toEqual({ $in: [oid(CELLAR_ID)] });

    expect((await request(`/api/cellars/multi/bottles?cellars=${OTHER}`)).status).toBe(403);
    expect((await request('/api/cellars/multi/bottles?cellars=junk')).status).toBe(400);
  });

  test('a chart filter loads the set once, capped and newest first, then filters, sorts and pages in memory', async () => {
    ROWS[B1] = bottleRow(B1, { bottleSize: '1500ml', vintage: '2019' });
    ROWS[B2] = bottleRow(B2, { bottleSize: '1500ml', vintage: '2012' });
    ROWS[B3] = bottleRow(B3, { vintage: '2001' });
    listIs(ROWS[B1], ROWS[B2], ROWS[B3]);

    const { body } = await both('&bottleSize=1500ml&sort=vintage&limit=1&skip=1');

    expect(listQueries()).toEqual([{ filter: SET, sort: { createdAt: -1 }, limit: 10000 }]);
    expect(Bottle.countDocuments).not.toHaveBeenCalled();
    // Two magnums, 2012 before 2019: the second is this page.
    expect(body.bottles).toMatchObject({ total: 2, limit: 1, skip: 1 });
    expect(idsOf(body.bottles.items)).toEqual([B1]);
  });

  test('a rating filter keeps the bottles whose own rating is within it', async () => {
    ROWS[B1] = bottleRow(B1, { rating: 5, ratingScale: '5' });
    ROWS[B2] = bottleRow(B2, { rating: 2, ratingScale: '5' });
    listIs(ROWS[B1], ROWS[B2], ROWS[B3]);

    const { body } = await both('&minRating=80');

    expect(listQueries()).toEqual([{ filter: SET, sort: { createdAt: -1 }, limit: 10000 }]);
    expect(body.bottles.total).toBe(1);
    expect(idsOf(body.bottles.items)).toEqual([B1]);
  });

  test('a maturity filter and the maturity order read each bottle, and every bottle carries its status', async () => {
    ROWS[B1] = bottleRow(B1, { drinkFrom: YEAR + 5 });
    ROWS[B2] = bottleRow(B2, { drinkFrom: YEAR - 1, drinkTo: YEAR + 1 });
    ROWS[B3] = bottleRow(B3, { drinkTo: YEAR - 1 });
    listIs(ROWS[B1], ROWS[B2], ROWS[B3]);

    const filtered = await both('&maturity=peak,declining');
    expect(filtered.body.bottles.items.map((b) => [String(b._id), b.maturityStatus]).sort()).toEqual([[B2, 'peak'], [B3, 'declining']].sort());

    // Drink soonest first: past its window, at its peak, not ready yet.
    const ordered = await both('&sort=maturity');
    expect(ordered.body.bottles.items.map((b) => [String(b._id), b.maturityStatus])).toEqual([[B3, 'declining'], [B2, 'peak'], [B1, 'not-ready']]);
    const reversed = await both('&sort=-maturity');
    expect(idsOf(reversed.body.bottles.items)).toEqual([B1, B2, B3]);
  });

  test('the name order sorts in memory, A to Z or Z to A, a bottle without a wine last', async () => {
    ROWS[B1] = bottleRow(B1, { wineDefinition: { _id: '64b0000000000000000000f1', name: 'Zinfandel' } });
    ROWS[B2] = bottleRow(B2, { wineDefinition: { _id: '64b0000000000000000000f2', name: 'albariño' } });
    listIs(ROWS[B1], ROWS[B2], ROWS[B3]);

    expect(idsOf((await both('&sort=name')).body.bottles.items)).toEqual([B2, B1, B3]);
    expect(idsOf((await both('&sort=-name')).body.bottles.items)).toEqual([B3, B1, B2]);
  });

  test('a repeated or bracketed parameter is read as absent, never a 500', async () => {
    const { status } = await both('&sort=name&sort=vintage&search[$gt]=x&minRating=1&minRating=2');

    expect(status).toBe(200);
    // No sort, no search, no rating limit: the default view.
    expect(listQueries()).toEqual([{ filter: SET, sort: { createdAt: -1 }, skip: 0, limit: 30 }]);
    expect(bottleSearch.searchBottles).not.toHaveBeenCalled();
  });
});

// "Open now" above the list: the first page of either list names the open
// bottles of the cellars in view (whatever the filters); later pages do not
// ask again, and a failed lookup shows no strip instead of failing the list.
describe('openBottles for the "Open now" strip', () => {
  const OPEN = { _id: B3, cellar: CELLAR_2, vintage: '2019', openedAt: new Date('2026-10-30T19:00:00Z'), preservationMethod: 'vacuum', pours: [] };

  test('a cellar\'s first page carries its open bottles; a later page does not ask', async () => {
    listOpenBottles.mockResolvedValue([{ ...OPEN, cellar: CELLAR_ID }]);
    const first = await request(`/api/cellars/${CELLAR_ID}`);
    expect(listOpenBottles).toHaveBeenCalledWith([CELLAR_ID]);
    expect(first.body.openBottles.map((b) => b._id)).toEqual([B3]);

    listOpenBottles.mockClear();
    const later = await request(`/api/cellars/${CELLAR_ID}?skip=30`);
    expect(later.status).toBe(200);
    expect(listOpenBottles).not.toHaveBeenCalled();
    expect(later.body.openBottles).toBeUndefined();
  });

  test('"all my cellars" names each open bottle\'s cellar', async () => {
    bottleSearch.searchBottles.mockResolvedValue(FOUND([B2, B1]));
    listOpenBottles.mockResolvedValue([OPEN]);
    const { body } = await request(`/api/cellars/multi/bottles?cellars=${CELLAR_ID},${CELLAR_2}&search=margaux`);
    expect(listOpenBottles).toHaveBeenCalledWith([CELLAR_ID, CELLAR_2]);
    expect(body.openBottles).toEqual([expect.objectContaining({ _id: B3, cellarName: 'Home' })]);
  });

  test('a failed lookup leaves the strip empty, never the list', async () => {
    listOpenBottles.mockRejectedValue(new Error('down'));
    const { status, body } = await request(`/api/cellars/${CELLAR_ID}`);
    expect(status).toBe(200);
    expect(body.openBottles).toEqual([]);
    expect(idsOf(body.bottles.items)).toEqual([B3]);
  });
});
