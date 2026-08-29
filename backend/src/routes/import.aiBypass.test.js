/**
 * POST /api/bottles/import/validate — the complete-row AI bypass.
 *
 * "The somm is free and we pay for AI" (Johan, 2026-08-29). A row whose file
 * already states producer + name + a resolvable country (+ a type, stated or
 * colour-inferred from the file's grapes) is identified BY THE FILE:
 * Pass 1a sets pr.aiIdentified from the row and Pass 2 treats it exactly like
 * an AI answer — matchOnly probe, proposal, ai_match/ai_new statuses — while
 * identifyWineFromText is never called and nothing is debited. One measured
 * import spent 430 AI calls on rows that were almost all complete.
 *
 * Locked here:
 *   - complete row → NO AI call; ai_new proposal built from the file,
 *     aiBypassed on the row; ai_match when the registry probe hits
 *   - the file's country alias resolves ("AU" → "Australia")
 *   - type inference: no type column + Riesling grapes → 'white'
 *   - incomplete rows (no country; no type and no colour-inferrable grape)
 *     still go to AI — the bypass never starves the rows AI is FOR
 *   - forceAi (the row's Look-up button) still forces a real AI call
 *
 * Harness cloned from import.validate.aiBudget.test.js.
 */

process.env.JWT_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

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
    })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
  return model;
});
// The type-inference colour map reads the grape taxonomy once, lazily.
jest.mock('../models/Grape', () => {
  const state = { docs: [] };
  return {
    find: jest.fn(() => ({ select: () => ({ lean: async () => state.docs }) })),
    __state: state,
  };
});
// In-memory AiUsage so a bypass row provably debits nothing.
jest.mock('../models/AiUsage', () => {
  const store = new Map();
  return {
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const k = `${filter.userId}|${filter.date}`;
      if (!store.has(k)) store.set(k, { userId: filter.userId, date: filter.date, count: 0 });
      const doc = store.get(k);
      if (update.$inc && typeof update.$inc.count === 'number') doc.count += update.$inc.count;
      return { ...doc };
    }),
    __store: store,
  };
});
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Grape = require('../models/Grape');
const AiUsage = require('../models/AiUsage');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

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

const COMPLETE = {
  wineName: 'Old Vine Reserve Malbec',
  producer: 'Altocedro',
  country: 'Argentina',
  region: 'La Consulta',
  appellation: 'Uco Valley',
  type: 'red',
  grapes: ['Malbec'],
  vintage: '2019',
};

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  WineDefinition.__state.exactByKey.clear();
  WineDefinition.__state.candidates = [];
  Grape.__state.docs = [];
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  // Registry knows nothing unless a test says otherwise.
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
  identifyWineFromText.mockResolvedValue({
    data: { name: 'AI Name', producer: 'AI Producer', country: 'France', type: 'red', grapes: [], confidence: 0.9 },
    debugRaw: 'raw',
    debugReason: null,
  });
});

describe('complete-row AI bypass', () => {
  it('a complete row spends no AI call and proposes the file identity', async () => {
    const { status, body } = await validate([COMPLETE]);
    expect(status).toBe(200);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(AiUsage.__store.size).toBe(0); // nothing debited

    const row = body.results[0];
    expect(row.status).toBe('ai_new');
    expect(row.aiBypassed).toBe(true);
    expect(row.aiProposed).toMatchObject({
      name: 'Old Vine Reserve Malbec',
      producer: 'Altocedro',
      country: 'Argentina',
      region: 'La Consulta',
      type: 'red',
    });
    // The probe ran on the FILE identity, read-only.
    expect(findOrCreateWine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Old Vine Reserve Malbec', producer: 'Altocedro' }),
      USER_ID,
      expect.objectContaining({ matchOnly: true })
    );
  });

  it('resolves ai_match without AI when the registry probe hits', async () => {
    const known = {
      _id: '64b0000000000000000000c9', name: 'Old Vine Reserve Malbec', producer: 'Altocedro',
      type: 'red', image: null, country: { name: 'Argentina' }, region: { name: 'La Consulta' },
      appellation: 'Uco Valley', grapes: [],
    };
    findOrCreateWine.mockResolvedValue({ wine: known, created: false });

    const { body } = await validate([COMPLETE]);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    const row = body.results[0];
    expect(row.status).toBe('ai_match');
    expect(row.aiBypassed).toBe(true);
    expect(row.matches[0].wineId).toBe(known._id);
  });

  it('the file country alias resolves — "AU" imports as Australia', async () => {
    const { body } = await validate([{ ...COMPLETE, country: 'AU' }]);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(body.results[0].aiProposed.country).toBe('Australia');
  });

  it('no type column + white grapes → type inferred white, still no AI', async () => {
    Grape.__state.docs = [
      { name: 'Riesling', normalizedName: 'riesling', normalizedSynonyms: [], color: 'White' },
    ];
    const { body } = await validate([{
      ...COMPLETE, wineName: 'Polish Hill Riesling', producer: 'Grosset',
      type: '', grapes: ['Riesling'],
    }]);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(body.results[0].aiProposed.type).toBe('white');
    expect(body.results[0].aiBypassed).toBe(true);
  });

  it('rows the bypass is NOT for still reach the AI', async () => {
    const { body } = await validate([
      { ...COMPLETE, wineName: 'No Country Cuvée', country: '' },          // no country
      { ...COMPLETE, wineName: 'No Type No Grapes', type: '', grapes: [] }, // type undecidable
      { ...COMPLETE, wineName: 'Unknown Producer Row', producer: 'Unknown' }, // sentinel producer
    ]);
    expect(identifyWineFromText).toHaveBeenCalledTimes(3);
    for (const row of body.results) expect(row.aiBypassed).toBeUndefined();
  });

  it('forceAi overrides the bypass — the Look-up button means a real call', async () => {
    await validate([{ ...COMPLETE, forceAi: true }]);
    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
  });
});
