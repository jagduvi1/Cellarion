/**
 * Producer-less import rows (2026-09-14).
 *
 * A CellarTracker export without a Producer column carries the producer
 * inside the Wine display name ("Louis Jadot Moulin-à-Vent Château des
 * Jacques"). The client used to guess the first word; on 2026-09-12 that
 * minted 285 registry wines under "Louis", "Kim", "19"… and cost the
 * curators 121 corrections. Now the client sends the row with an EMPTY
 * producer and /validate:
 *   1. splits the display name on the longest leading token run that equals
 *      a producer the registry already knows, then runs the ordinary cascade;
 *   2. otherwise sends the full display name to the model with the producer
 *      slot told to split it (no AI configured here → falls to Pass 3).
 *
 * Harness cloned from import.validate.noAi.test.js.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/priceWarnings', () => ({
  computeUserMediansByCurrency: jest.fn().mockResolvedValue({}),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/AiUsage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});

jest.mock('../models/WineDefinition', () => {
  // exactByKey: the registry as the cascade's exact lookup sees it (string
  // key → populated doc). The same docs answer the producer-prefix probe
  // (anchored RegExp on normalizedKey → .select().lean()).
  const state = { exactByKey: new Map(), candidates: [] };
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  const model = {
    findOne: jest.fn((filter) => {
      const key = filter && filter.normalizedKey;
      const byPrefix = key instanceof RegExp
        ? [...state.exactByKey.values()].find((w) => key.test(w.normalizedKey) && !w.nonWine) || null
        : null;
      return {
        populate: async () => (typeof key === 'string' ? state.exactByKey.get(key) ?? null : null),
        select: () => ({ lean: async () => byPrefix }),
      };
    }),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    // The one-word corroboration count: wines whose key matches the anchored producer prefix.
    countDocuments: jest.fn(async (filter) => {
      const key = filter && filter.normalizedKey;
      return key instanceof RegExp ? [...state.exactByKey.values()].filter((w) => key.test(w.normalizedKey) && !w.nonWine).length : 0;
    }),
    __state: state,
  };
  return model;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

const JADOT = {
  _id: '64b0000000000000000000c1',
  name: 'Moulin-à-Vent Château des Jacques',
  producer: 'Louis Jadot',
  appellation: null,
  type: 'red',
  image: null,
  country: { name: 'France' },
  region: { name: 'Beaujolais' },
  normalizedKey: 'louis jadot:moulinavent chateau des jacques:',
};
// A one-word producer that is a genuine registry producer — the split must
// prefer the LONGER known prefix when both exist.
const LOUIS_LATOUR = {
  _id: '64b0000000000000000000c2',
  name: 'Bourgogne Chardonnay',
  producer: 'Louis Latour',
  appellation: null,
  type: 'white',
  image: null,
  country: { name: 'France' },
  region: { name: 'Burgundy' },
  normalizedKey: 'louis latour:bourgogne chardonnay:',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return app;
}

function authToken() {
  return jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

function postJson(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${authToken()}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

const validate = (items) => postJson(buildApp(), '/api/bottles/import/validate', { cellarId: CELLAR_ID, items });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.__state.exactByKey.clear();
  WineDefinition.__state.candidates = [];
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
});

test('a producer-less display name is split on a producer the registry knows and resolves exact', async () => {
  WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);

  const res = await validate([
    { wineName: 'Louis Jadot Moulin-à-Vent Château des Jacques', producer: '', vintage: '2001' },
  ]);

  expect(res.status).toBe(200);
  const [row] = res.body.results;
  expect(row.status).toBe('exact');
  expect(row.matches[0].wineId).toBe(JADOT._id);
  // The echoed row carries the split, so the preview and /confirm see a producer.
  expect(row.item.producer).toBe('Louis Jadot');
  expect(row.item.wineName).toBe('Moulin-à-Vent Château des Jacques');
  expect(identifyWineFromText).not.toHaveBeenCalled();
  expect(findOrCreateWine).not.toHaveBeenCalled();
});

test('the LONGEST known producer wins — "Louis Latour" is not split as "Louis"', async () => {
  WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);
  WineDefinition.__state.exactByKey.set(LOUIS_LATOUR.normalizedKey, LOUIS_LATOUR);

  const res = await validate([{ wineName: 'Louis Latour Bourgogne Chardonnay', vintage: '2020' }]);

  const [row] = res.body.results;
  expect(row.status).toBe('exact');
  expect(row.matches[0].wineId).toBe(LOUIS_LATOUR._id);
  expect(row.item.producer).toBe('Louis Latour');
  expect(row.item.wineName).toBe('Bourgogne Chardonnay');
});

test('a display name the registry cannot split keeps its full name and an empty producer — never the first word', async () => {
  WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);

  const res = await validate([{ wineName: 'Kim Crawford Pinot Gris', vintage: '2022' }]);

  expect(res.status).toBe(200);
  const [row] = res.body.results;
  expect(row.status).toBe('no_match'); // no AI in this harness → fuzzy fallback, nothing to match
  expect(row.item.wineName).toBe('Kim Crawford Pinot Gris');
  expect(row.item.producer ?? '').toBe('');
  expect(findOrCreateWine).not.toHaveBeenCalled();
});

test('a split is never attempted on a row that states its producer', async () => {
  WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);

  const res = await validate([
    { wineName: 'Moulin-à-Vent Château des Jacques', producer: 'Louis Jadot', vintage: '2001' },
  ]);

  const [row] = res.body.results;
  expect(row.status).toBe('exact');
  // Only the exact-key lookups ran: no RegExp probe was issued.
  const regexProbes = WineDefinition.findOne.mock.calls.filter(([f]) => f && f.normalizedKey instanceof RegExp);
  expect(regexProbes).toHaveLength(0);
});

test('a two-word display name with no known producer is left alone (one token is not a wine name)', async () => {
  const res = await validate([{ wineName: 'Opus One', vintage: '2019' }]);

  const [row] = res.body.results;
  expect(row.item.wineName).toBe('Opus One');
  expect(row.item.producer ?? '').toBe('');
});

describe('audit 2026-09-14 hardening of the registry split', () => {
  const KIM_JUNK = { // the 09-12 first-word residue: ONE wine under a one-word producer
    _id: '64b0000000000000000000c3', name: 'Crawford Pinot Gris', producer: 'Kim', appellation: null, type: 'white', image: null,
    country: { name: 'New Zealand' }, region: { name: 'Marlborough' }, normalizedKey: 'kim:crawford pinot gris:',
  };
  const HUGEL_A = {
    _id: '64b0000000000000000000c4', name: 'Gentil', producer: 'Hugel', appellation: 'Alsace', type: 'white', image: null,
    country: { name: 'France' }, region: { name: 'Alsace' }, normalizedKey: 'hugel:gentil:alsace',
  };
  const HUGEL_B = {
    _id: '64b0000000000000000000c5', name: 'Riesling Classic', producer: 'Hugel', appellation: 'Alsace', type: 'white', image: null,
    country: { name: 'France' }, region: { name: 'Alsace' }, normalizedKey: 'hugel:riesling classic:alsace',
  };

  test('a ONE-word producer with a single registry wine is not trusted — the row keeps its display name (M1)', async () => {
    WineDefinition.__state.exactByKey.set(KIM_JUNK.normalizedKey, KIM_JUNK);
    const res = await validate([{ wineName: 'Kim Crawford Sauvignon Blanc', vintage: '2023' }]);
    const [row] = res.body.results;
    expect(row.item.producer ?? '').toBe('');
    expect(row.item.wineName).toBe('Kim Crawford Sauvignon Blanc');
  });

  test('a ONE-word producer with two or more registry wines is corroborated and splits', async () => {
    WineDefinition.__state.exactByKey.set(HUGEL_A.normalizedKey, HUGEL_A);
    WineDefinition.__state.exactByKey.set(HUGEL_B.normalizedKey, HUGEL_B);
    const res = await validate([{ wineName: 'Hugel Gewurztraminer Classic', vintage: '2022' }]);
    const [row] = res.body.results;
    expect(row.item.producer).toBe('Hugel');
    expect(row.item.wineName).toBe('Gewurztraminer Classic');
  });

  test('a sentinel producer ("Unknown", "-") counts as none: cleared, then split like a producer-less row (L4)', async () => {
    WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);
    const res = await validate([
      { wineName: 'Louis Jadot Moulin-à-Vent Château des Jacques', producer: 'Unknown', vintage: '2001' },
      { wineName: 'Zyxwv Mystery Estate Cuvée', producer: '-', vintage: '2019' },
    ]);
    expect(res.body.results[0].item.producer).toBe('Louis Jadot');
    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[1].item.producer ?? '').toBe(''); // sentinel gone, nothing to split on
  });

  test('duplicate display names are probed ONCE (M2)', async () => {
    WineDefinition.__state.exactByKey.set(JADOT.normalizedKey, JADOT);
    const row = { wineName: 'Louis Jadot Moulin-à-Vent Château des Jacques' };
    await validate([{ ...row, vintage: '2001' }, { ...row, vintage: '2002' }, { ...row, vintage: '2003' }]);
    const probes = WineDefinition.findOne.mock.calls.filter(([f]) => f && f.normalizedKey instanceof RegExp);
    // Longest-first: 5 tokens down to the 2-token hit "louis jadot" → 4 probes for ONE distinct name, not 12.
    expect(probes.length).toBeLessThanOrEqual(5);
  });
});
