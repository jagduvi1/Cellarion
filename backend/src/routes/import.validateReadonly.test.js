/**
 * Import flow registry-write boundary (security audit 2026-08-03 H-1).
 *
 * WHY THIS TEST EXISTS:
 * POST /validate is a PREVIEW — the user may cancel, re-run, or remap columns
 * any number of times, and none of that is consent to write to the SHARED
 * registry. The route used to call findOrCreateWine WITHOUT matchOnly during
 * validation, minting a WineDefinition (+ taxonomy) for every AI-identified
 * unknown wine on every validate pass; those rows are the residual half of the
 * #884 registry-growth root cause. The contract pinned here:
 *
 *   1. /validate NEVER creates: every findOrCreateWine call carries
 *      matchOnly: true. An AI-identified wine the registry doesn't know comes
 *      back as status 'ai_new' with the canonical proposal in `aiProposed` —
 *      and no wineId, because none exists yet.
 *   2. /confirm is the ONLY step that creates, and only for rows the user
 *      actually imports (item.aiWine): findOrCreateWine runs WITHOUT
 *      matchOnly, with createdVia:'import', once per unique wine per batch,
 *      and the creation is audit-logged ('wine.create', via:'import' — same
 *      stream as the MCP/admin/find-or-create surfaces).
 *   3. The gate matches /api/wines/find-or-create: demo accounts get a
 *      per-row error, malformed aiWine data a per-row error — never a throw,
 *      never a write.
 *
 * Real router + real requireAuth (HS256 test tokens); models and the AI layer
 * are mocked (repo unit-test style — the full round-trip lives in the Docker
 * smoke test).
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

// ── Model mocks ──────────────────────────────────────────────────────────────

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/WishlistItem', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) };
  model.RACK_TYPES = ['grid'];
  return model;
});

jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  return Bottle;
});

jest.mock('../models/WineRequest', () => {
  const instances = [];
  function WineRequest(data) {
    Object.assign(this, data);
    this._id = `winereq-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  WineRequest.__instances = instances;
  WineRequest.findOne = jest.fn().mockResolvedValue(null); // intake reuse lookup (services/wineRequestIntake)
  return WineRequest;
});

// No exact key match, no fuzzy candidates — every wine is unknown to the
// registry, which is exactly the case whose write behaviour is under test.
jest.mock('../models/WineDefinition', () => {
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  return {
    findOne: jest.fn(() => ({ populate: async () => null })),
    find: jest.fn(() => chain([])),
    findById: jest.fn(),
  };
});

// requireAuth verifies demo tokens against the User collection.
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  exists: jest.fn(async () => true),
}));

// In-memory AiUsage so the real aiBudget debit logic runs without Mongo —
// without this mock the real model buffers forever and /validate hangs.
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

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { logAudit } = require('../services/audit');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const CREATED_WINE_ID = '64b0000000000000000000c9';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return app;
}

function postJson(app, url, body, { demo = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const token = jwt.sign(
        { id: USER_ID, roles: ['user'], ...(demo ? { isDemo: true } : {}) },
        'test-secret', { algorithm: 'HS256', expiresIn: '1h' }
      );
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${token}`,
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

const validate = (items, opts) =>
  postJson(buildApp(), '/api/bottles/import/validate', { cellarId: CELLAR_ID, items }, opts);
const confirm = (items, opts) =>
  postJson(buildApp(), '/api/bottles/import/confirm', { cellarId: CELLAR_ID, items }, opts);

const AI_WINE = {
  name: 'Clos du Test', producer: 'Domaine Fictif', country: 'France',
  region: 'Burgundy', appellation: 'Gevrey-Chambertin', type: 'red',
  grapes: ['Pinot Noir'], confidence: 0.9,
};

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  identifyWineFromText.mockResolvedValue({ data: { ...AI_WINE }, debugRaw: 'raw', debugReason: null });
  // Registry-unknown by default: matchOnly resolves to noMatch, a real call creates.
  findOrCreateWine.mockImplementation(async (wineData, userId, opts = {}) => {
    if (opts.matchOnly) return { wine: null, noMatch: true };
    return {
      wine: { _id: CREATED_WINE_ID, name: wineData.name, producer: wineData.producer, type: wineData.type },
      created: true,
    };
  });
});

// ── 1. /validate is read-only ────────────────────────────────────────────────

describe('POST /validate never writes to the registry', () => {
  test('every findOrCreateWine call is matchOnly; unknown wines come back as ai_new + aiProposed', async () => {
    const res = await validate([
      { wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' },
    ]);

    expect(res.status).toBe(200);
    expect(findOrCreateWine).toHaveBeenCalled();
    for (const call of findOrCreateWine.mock.calls) {
      expect(call[2]).toMatchObject({ matchOnly: true });
    }

    const row = res.body.results[0];
    expect(row.status).toBe('ai_new');
    expect(row.aiProposed).toMatchObject({
      name: 'Clos du Test', producer: 'Domaine Fictif', country: 'France', type: 'red',
    });
    expect(row.matches).toEqual([]); // nothing exists yet, so no wineId anywhere
    expect(res.body.summary.aiNew).toBe(1);
  });

  test('re-running validate N times still creates nothing (the original H-1 minted per pass)', async () => {
    for (let i = 0; i < 3; i++) {
      await validate([{ wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' }]);
    }
    const nonMatchOnly = findOrCreateWine.mock.calls.filter((c) => !c[2]?.matchOnly);
    expect(nonMatchOnly).toHaveLength(0);
  });

  test('a registry match during validate is still returned as ai_match with its wineId', async () => {
    const EXISTING = { _id: '64b0000000000000000000c5', name: 'Clos du Test', producer: 'Domaine Fictif', appellation: null, type: 'red', image: null, country: { name: 'France' }, region: { name: 'Burgundy' } };
    findOrCreateWine.mockResolvedValue({ wine: EXISTING, created: false });

    const res = await validate([{ wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' }]);
    const row = res.body.results[0];
    expect(row.status).toBe('ai_match');
    expect(row.matches[0].wineId).toBe(EXISTING._id);
    expect(row.aiProposed).toBeUndefined();
  });
});

// ── 2. /confirm is the single creating step ──────────────────────────────────

describe('POST /confirm creates the confirmed AI wine', () => {
  const aiItem = (extra = {}) => ({
    aiWine: { ...AI_WINE }, wineName: 'Clos du Test', producer: 'Domaine Fictif',
    vintage: '2019', ...extra,
  });

  test('creates via findOrCreateWine (no matchOnly, createdVia import), audit-logs, and the bottle references the new wine', async () => {
    const res = await confirm([aiItem()]);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([]);

    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    const [wineData, userId, opts] = findOrCreateWine.mock.calls[0];
    expect(wineData).toMatchObject({ name: 'Clos du Test', producer: 'Domaine Fictif', country: 'France' });
    expect(userId).toBe(USER_ID);
    expect(opts).toMatchObject({ createdVia: 'import' });
    expect(opts.matchOnly).toBeUndefined();

    expect(Bottle.__instances[0].wineDefinition).toBe(CREATED_WINE_ID);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'wine.create',
      expect.objectContaining({ type: 'wine', id: CREATED_WINE_ID }),
      expect.objectContaining({ via: 'import' })
    );
  });

  test('duplicate rows of the same wine resolve it ONCE per batch', async () => {
    const res = await confirm([aiItem(), aiItem({ vintage: '2020' })]);
    expect(res.body.created).toBe(2);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
  });

  test('a wine minted since validate dedupes instead of duplicating (created:false → no audit row)', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: { _id: CREATED_WINE_ID, name: 'Clos du Test', producer: 'Domaine Fictif' },
      created: false,
    });
    const res = await confirm([aiItem()]);
    expect(res.body.created).toBe(1);
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
  });

  test('demo accounts are stopped at the router (requireNonDemo) — no registry call possible', async () => {
    const res = await confirm([aiItem()], { demo: true });
    expect(res.status).toBe(403);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(Bottle.__instances).toHaveLength(0);
  });

  test('malformed aiWine (non-string name) is a per-row error, not a throw and not a write', async () => {
    const res = await confirm([aiItem({ aiWine: { ...AI_WINE, name: 42 } })]);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('regression: plain wineDefinition and requestWine rows are untouched by the aiWine branch', async () => {
    const WineDefinition = require('../models/WineDefinition');
    const WINE_ID = '64b0000000000000000000cc';
    WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Known', producer: 'Prod' });

    const res = await confirm([
      { wineDefinition: WINE_ID, wineName: 'Known', producer: 'Prod', vintage: '2018' },
      { requestWine: true, wineName: 'Mystery', producer: 'Unknown Prod', vintage: '2017' },
    ]);
    expect(res.body.created).toBe(2);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });
});
