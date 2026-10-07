/**
 * POST /api/bottles/import/validate — the colourConflict gate.
 *
 * Neither the normalizedKey (`producer:name:appellation`) nor the scorer reads
 * colour, so where a producer sells a red and a white under one name the
 * registry-first cascade filed a file's RED rows under the registry's WHITE
 * with status 'exact' — the status users are told needs no review. Found on a
 * Châteauneuf-du-Pape pair: CellarTracker rows typed red landed on the white.
 *
 * Locked here, with AI unconfigured (the cascade and the fuzzy path are the
 * whole pipeline):
 *   - an exact-KEY hit of the other colour does not auto-link: the row comes
 *     back 'fuzzy' with colourConflict on the match (the client never
 *     preselects it — utils/importReview.preselectableMatch)
 *   - the same row of the right colour, an untyped row, and a sparkling rosé
 *     row against a sparkling rosé record still auto-link — the gate fails open
 *   - a file holding BOTH colours under one name (one shared representative)
 *     links only the row whose colour fits
 *
 * Harness cloned from import.styleGuard.test.js: real router, real auth,
 * in-memory WineDefinition.
 */

process.env.JWT_SECRET = 'test-secret';

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
jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});
jest.mock('../models/WineDefinition', () => {
  const state = { exactByKey: new Map(), candidates: [] };
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  const model = {
    findOne: jest.fn((filter) => ({
      populate: async () => {
        const keys = filter?.normalizedKey?.$in ?? [filter?.normalizedKey];
        for (const k of keys) {
          if (state.exactByKey.has(k)) return state.exactByKey.get(k);
        }
        return null;
      },
      // splitKnownProducerPrefix's probe (select → lean); not exercised here.
      select: () => ({ lean: async () => null }),
    })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
  return model;
});
jest.mock('../models/AiUsage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { generateWineKey } = require('../utils/normalize');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

const PRODUCER = 'Domaine Exemple';
const NAME = 'Châteauneuf-du-Pape';
const APPELLATION = 'Châteauneuf-du-Pape';

// The registry holds the WHITE under the plain name; the file's bottle is red.
const WHITE = {
  _id: '64b0000000000000000000c1',
  name: NAME,
  producer: PRODUCER,
  appellation: APPELLATION,
  type: 'white',
  colour: null,
  image: null,
  country: { name: 'France' },
  region: { name: 'Rhône Valley' },
  normalizedKey: generateWineKey(NAME, PRODUCER, APPELLATION),
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
const row = (type) => ({
  wineName: NAME, producer: PRODUCER, appellation: APPELLATION, country: 'France', vintage: '2019',
  ...(type !== undefined ? { type } : {}),
});

function useRegistry(wine) {
  WineDefinition.__state.exactByKey.clear();
  WineDefinition.__state.exactByKey.set(wine.normalizedKey, wine);
  WineDefinition.__state.candidates = [wine];
}

beforeEach(() => {
  jest.clearAllMocks();
  useRegistry(WHITE);
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
});

describe('import cascade — colourConflict gate', () => {
  it('an exact-key hit of the other colour never auto-links as exact', async () => {
    const { status, body } = await validate([row('red')]);

    expect(status).toBe(200);
    const r = body.results[0];
    expect(r.status).toBe('fuzzy');
    expect(r.matches[0].wineId).toBe(WHITE._id);
    expect(r.matches[0].colourConflict).toBe('the file says red, the registry wine is white');
  });

  it('the same row in the right colour still auto-links — the cascade is not blunted', async () => {
    const { body } = await validate([row('white')]);
    expect(body.results[0].status).toBe('exact');
    expect(body.results[0].matches[0].wineId).toBe(WHITE._id);
  });

  it('fails open: an untyped row still auto-links', async () => {
    const { body } = await validate([row(undefined)]);
    expect(body.results[0].status).toBe('exact');
  });

  it('reads the file colour case-insensitively ("Red" is red)', async () => {
    const { body } = await validate([row('Red')]);
    expect(body.results[0].status).toBe('fuzzy');
    expect(body.results[0].matches[0].colourConflict).toMatch(/file says red/);
  });

  it('a rosé row matches a sparkling rosé record (its colour field), a red row does not', async () => {
    useRegistry({ ...WHITE, type: 'sparkling', colour: 'rosé' });
    const rose = await validate([row('rosé')]);
    expect(rose.body.results[0].status).toBe('exact');

    const red = await validate([row('red')]);
    expect(red.body.results[0].status).toBe('fuzzy');
    expect(red.body.results[0].matches[0].colourConflict).toBe('the file says red, the registry wine is rosé');
  });

  it('one file with both colours under one name links only the row whose colour fits', async () => {
    // One shared representative (same name + producer): the white row comes
    // first, takes the exact hit, and the red row must not inherit it.
    const { body } = await validate([row('white'), row('red')]);
    const [white, red] = body.results;
    expect(white.status).toBe('exact');
    expect(red.status).toBe('fuzzy');
    expect(red.matches[0].colourConflict).toMatch(/file says red/);
  });
});
