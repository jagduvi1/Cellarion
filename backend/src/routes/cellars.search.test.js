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
function bottleQuery(filter) {
  let rows;
  if (filter && filter._id && filter._id.$in) {
    rows = filter._id.$in.map((id) => ROWS[String(id)]).filter(Boolean).reverse();
  } else if (filter && filter.user) {
    rows = []; // sibling-photo lookup in attachBottleImageUrls
  } else {
    rows = LIST;
  }
  const q = {
    populate: () => q, sort: () => q, skip: () => q, limit: () => q, select: () => q,
    lean: async () => rows.map((r) => ({ ...r })),
  };
  return q;
}

const FOUND = (ids) => ({
  ids,
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
