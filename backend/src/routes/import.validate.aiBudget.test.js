/**
 * POST /api/bottles/import/validate — registry-first cascade + shared AI
 * budget (SECURITY_AUDIT_2026-07-08 M-2 + L-14).
 *
 * WHY THIS TEST EXISTS:
 * The guiding product constraint is that a legitimate 2,000-bottle import
 * must NEVER break or degrade below the pre-change quality — only abusive
 * spend gets capped. That means:
 *
 *   1. CASCADE — wines the registry already knows resolve WITHOUT an AI call
 *      (exact normalizedKey, or fuzzy score >= 0.95 where the AI's
 *      canonicalized result would dedup to the same registry wine anyway),
 *      with the same wineId the AI path would have produced. Unknown wines
 *      still get AI — match quality for messy input is unchanged. The
 *      cascade must survive producer-embedded wine names (CellarTracker has
 *      no Producer column).
 *   2. BUDGET/CAP/DISCONNECT — when the shared daily budget (or global cap,
 *      or per-request fan-out cap) stops AI mid-import, the remaining rows
 *      fall through to the existing fuzzy path with aiSkipped: true and a
 *      summary-level aiBudgetExhausted flag — never an error.
 *   3. REGRESSION — without budget pressure, responses carry no new fields
 *      and the AI path is byte-identical to before.
 *
 * Real router + real requireAuth (HS256 test tokens) + the REAL aiBudget
 * service and rateLimits config; models and the Anthropic layer are mocked.
 */

process.env.JWT_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

// services/search eagerly requires the ESM-only `meilisearch` package —
// stub it (matches the repo's unit-test style). Meilisearch "unavailable"
// exercises the MongoDB fallback strategies in findWineMatches.
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
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});

// Registry mock: exact normalizedKey lookups + the two MongoDB fallback
// candidate searches used by findWineMatches ($text, normalizedKey regex).
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

// In-memory AiUsage so the REAL aiBudget debit/refund logic runs without Mongo.
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

// The REAL aiBudget service now checks User.aiBudgetOverride (admin-granted
// temporary budget increases) — resolve "no override" so the base budget
// applies. Override behaviour itself is covered by services/aiBudget.test.js.
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const AiUsage = require('../models/AiUsage');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const rateLimitsConfig = require('../config/rateLimits');
const { todayUTC } = require('../services/aiBudget');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

// Registry wines — producer and name stored SEPARATELY (registry convention)
const LA_TACHE = {
  _id: '64b0000000000000000000c1',
  name: 'La Tâche',
  producer: 'Domaine de la Romanée-Conti',
  appellation: null,
  type: 'red',
  image: null,
  country: { name: 'France' },
  region: { name: 'Burgundy' },
  normalizedKey: 'domaine de la romaneeconti:la tache:', // normalizeString drops hyphens without padding
};
const ROMANEE_CONTI = {
  _id: '64b0000000000000000000c2',
  name: 'Romanée-Conti',
  producer: 'Domaine de la Romanée-Conti',
  appellation: null,
  type: 'red',
  image: null,
  country: { name: 'France' },
  region: { name: 'Burgundy' },
  normalizedKey: 'domaine de la romaneeconti:romaneeconti:',
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

const userDebits = () => AiUsage.__store.get(`${USER_ID}|${todayUTC()}`)?.count ?? 0;
const globalDebits = () => AiUsage.__store.get(`null|${todayUTC()}`)?.count ?? 0;

function setLimits(overrides = {}) {
  rateLimitsConfig.set({
    ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)),
    ...overrides,
  });
}

// Default AI behaviour: identify any "Mystery N" wine as a distinct new wine
// that findOrCreateWine then creates.
function mockAiIdentifiesEverything() {
  identifyWineFromText.mockImplementation(async ({ name, producer }) => ({
    data: { name, producer, country: 'France', type: 'red', grapes: [], confidence: 0.9 },
    debugRaw: 'raw',
    debugReason: null,
  }));
  findOrCreateWine.mockImplementation(async (wineData) => ({
    wine: {
      _id: `created-${wineData.name}`,
      name: wineData.name,
      producer: wineData.producer,
      appellation: null,
      type: 'red',
      image: null,
      country: { name: 'France' },
      region: null,
    },
    created: true,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  WineDefinition.__state.exactByKey.clear();
  WineDefinition.__state.candidates = [];
  setLimits();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  mockAiIdentifiesEverything();
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

// ── 1. Registry-first cascade ────────────────────────────────────────────────

describe('registry-first cascade (zero AI for known wines)', () => {
  beforeEach(() => {
    WineDefinition.__state.exactByKey.set(LA_TACHE.normalizedKey, LA_TACHE);
    WineDefinition.__state.candidates = [LA_TACHE, ROMANEE_CONTI];
  });

  test('exact normalizedKey match resolves without AI, same wineId as the AI path', async () => {
    const res = await validate([
      { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(res.body.results[0].matches[0].score).toBe(1);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(userDebits()).toBe(0); // zero AI = zero budget spend
  });

  test('(iii) diacritic-free row hits the exact key (normalizeString strips accents)', async () => {
    const res = await validate([
      { wineName: 'La Tache', producer: 'Domaine de la Romanee-Conti', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(identifyWineFromText).not.toHaveBeenCalled();
  });

  test('(ii) producer-embedded wine name hits the prefix-stripped exact key', async () => {
    const res = await validate([
      { wineName: 'Domaine de la Romanée-Conti La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    // The raw-as-typed key is queried FIRST (plain key, not a $in over both);
    // the prefix-stripped variant is the deterministic fallback that resolves
    // this producer-in-name row to the clean registry wine.
    expect(WineDefinition.findOne).toHaveBeenCalledTimes(2);
    const firstKey = WineDefinition.findOne.mock.calls[0][0].normalizedKey;
    const secondKey = WineDefinition.findOne.mock.calls[1][0].normalizedKey;
    expect(typeof firstKey).toBe('string');            // raw key, queried first (no $in)
    expect(firstKey).not.toBe(LA_TACHE.normalizedKey); // it's the raw-as-typed key, not the stripped one
    expect(secondKey).toBe(LA_TACHE.normalizedKey);    // stripped fallback hits the clean wine
  });

  test('BUG 4: exact lookup deterministically prefers the raw-as-typed key over a producer-in-name duplicate', async () => {
    // The registry holds BOTH a clean entry (producer + bare name) and a
    // "producer-in-name" duplicate (producer embedded in the name). A single
    // $in over both keys returns an arbitrary one (Mongo storage order); the
    // raw-first lookup must deterministically pick the entry matching the row
    // as typed.
    const { generateWineKey } = require('../utils/normalize');
    const rawKey = generateWineKey('Domaine de la Romanée-Conti La Tâche', 'Domaine de la Romanée-Conti');
    const strippedKey = generateWineKey('La Tâche', 'Domaine de la Romanée-Conti');
    expect(rawKey).not.toBe(strippedKey); // sanity: the two keys genuinely differ

    const RAW_DUP = { ...LA_TACHE, _id: 'raw-dup-id', normalizedKey: rawKey };     // producer-in-name duplicate
    const CLEAN = { ...LA_TACHE, _id: 'clean-id', normalizedKey: strippedKey };    // clean entry
    // Insert the CLEAN (stripped-key) entry FIRST — a $in-over-both lookup would
    // tend to surface it; the raw-first lookup must still pick the raw duplicate.
    WineDefinition.__state.exactByKey.set(strippedKey, CLEAN);
    WineDefinition.__state.exactByKey.set(rawKey, RAW_DUP);

    const res = await validate([
      { wineName: 'Domaine de la Romanée-Conti La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe('raw-dup-id'); // raw key wins, insertion order irrelevant
    expect(identifyWineFromText).not.toHaveBeenCalled();
  });

  test('(i) full display name with NO producer resolves via variant fuzzy at >= 0.95 (no AI eligible anyway)', async () => {
    const res = await validate([
      { wineName: 'Domaine de la Romanée-Conti La Tâche', producer: '', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    // Negative: the sibling grand cru must not cross-match at exact level
    const siblingMatch = res.body.results[0].matches.find(m => m.wineId === ROMANEE_CONTI._id);
    if (siblingMatch) expect(siblingMatch.score).toBeLessThan(0.95);
  });

  test('fuzzy >= 0.95 without an exact key still skips AI (outcome-identical shortcut)', async () => {
    // No exact key registered — only candidates for the fuzzy scorer
    WineDefinition.__state.exactByKey.clear();
    const res = await validate([
      { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(res.body.results[0].matches[0].score).toBeGreaterThanOrEqual(0.95);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(userDebits()).toBe(0);
  });

  test('unknown wine still gets AI — quality below the exact threshold is unchanged', async () => {
    const res = await validate([
      { wineName: 'Mystery Cuvée', producer: 'Unknown Estate', vintage: '2020' },
    ]);

    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
    expect(res.body.results[0].status).toBe('ai_match');
    expect(res.body.results[0].matches[0].aiIdentified).toBe(true);
    expect(userDebits()).toBe(1);
    expect(globalDebits()).toBe(1);
  });

  test('forceAi (per-row Look up button) bypasses the cascade and always reaches AI', async () => {
    const res = await validate([
      { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018', forceAi: true },
    ]);

    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
    expect(res.body.results[0].status).toBe('ai_match');
    expect(userDebits()).toBe(1);
  });

  test('duplicate rows of one unknown wine share a single AI call and a single debit', async () => {
    const row = { wineName: 'Mystery Cuvée', producer: 'Unknown Estate', vintage: '2019' };
    const res = await validate([row, { ...row, vintage: '2020' }, { ...row, vintage: '2021' }]);

    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
    expect(res.body.results).toHaveLength(3);
    for (const r of res.body.results) expect(r.status).toBe('ai_match');
    expect(userDebits()).toBe(1);
  });
});

// ── 2. Budget / cap / degradation ────────────────────────────────────────────

describe('shared daily AI budget and caps (graceful degradation, never an error)', () => {
  const mysteries = (n) =>
    Array.from({ length: n }, (_, i) => ({ wineName: `Mystery ${i}`, producer: `Estate ${i}`, vintage: '2020' }));

  test('budget exhaustion MID-import: remaining rows degrade to fuzzy with aiSkipped, response is 200', async () => {
    setLimits({ aiDailyBudget: { max: 2 } });

    const res = await validate(mysteries(4));

    expect(res.status).toBe(200);
    expect(identifyWineFromText).toHaveBeenCalledTimes(2); // debit gate stopped the rest
    const aiRows = res.body.results.filter(r => r.status === 'ai_match');
    const skippedRows = res.body.results.filter(r => r.aiSkipped === true);
    expect(aiRows).toHaveLength(2);
    expect(skippedRows).toHaveLength(2);
    for (const r of skippedRows) {
      expect(r.status).toBe('no_match'); // fuzzy path found nothing for these
      expect(r.error).toBeUndefined();
    }
    expect(res.body.summary.aiBudgetExhausted).toBe(true);
    expect(userDebits()).toBe(2); // overshoot refunded
  });

  test('budget already exhausted BEFORE the import: all rows degrade, none error', async () => {
    setLimits({ aiDailyBudget: { max: 1 } });
    AiUsage.__store.set(`${USER_ID}|${todayUTC()}`, { userId: USER_ID, date: todayUTC(), count: 1 });

    const res = await validate(mysteries(3));

    expect(res.status).toBe(200);
    expect(identifyWineFromText).not.toHaveBeenCalled();
    expect(res.body.results.every(r => r.aiSkipped === true)).toBe(true);
    expect(res.body.summary.aiBudgetExhausted).toBe(true);
  });

  test('per-request fan-out cap: excess unique wines are aiSkipped WITHOUT the budget flag', async () => {
    setLimits({ aiImportPerRequestCap: { max: 1 } });

    const res = await validate(mysteries(3));

    expect(res.status).toBe(200);
    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
    expect(res.body.results.filter(r => r.aiSkipped === true)).toHaveLength(2);
    expect(res.body.summary.aiBudgetExhausted).toBeUndefined(); // cap ≠ budget exhaustion
    expect(userDebits()).toBe(1); // capped wines were never debited
  });

  test('global daily kill-switch trips with the same degradation', async () => {
    setLimits({ aiGlobalDailyCap: { max: 1 } });

    const res = await validate(mysteries(2));

    expect(res.status).toBe(200);
    expect(identifyWineFromText).toHaveBeenCalledTimes(1);
    expect(res.body.results.filter(r => r.aiSkipped === true)).toHaveLength(1);
    expect(res.body.summary.aiBudgetExhausted).toBe(true);
    expect(globalDebits()).toBe(1);
  });

  test('cascade-known wines resolve even when the budget is exhausted (zero AI needed)', async () => {
    setLimits({ aiDailyBudget: { max: 1 } });
    AiUsage.__store.set(`${USER_ID}|${todayUTC()}`, { userId: USER_ID, date: todayUTC(), count: 1 });
    WineDefinition.__state.exactByKey.set(LA_TACHE.normalizedKey, LA_TACHE);

    const res = await validate([
      { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
    ]);

    expect(res.body.results[0].status).toBe('exact');
    expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
    expect(res.body.results[0].aiSkipped).toBeUndefined(); // full-quality outcome, not degradation
    expect(res.body.summary.aiBudgetExhausted).toBeUndefined();
  });

  test('a transport failure refunds the debit (failed calls never burn budget)', async () => {
    identifyWineFromText.mockResolvedValue({ data: null, debugRaw: 'boom', debugReason: 'exception: socket hang up' });

    const res = await validate(mysteries(1));

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('no_match');
    expect(res.body.results[0].aiSkipped).toBeUndefined(); // AI was attempted, not skipped
    expect(userDebits()).toBe(0);
    expect(globalDebits()).toBe(0);
  });
});

// ── 3. Regression: no budget pressure ⇒ byte-identical behaviour ────────────

describe('regression — imports without budget pressure', () => {
  test('AI-path rows carry exactly the pre-change fields (no aiSkipped, no summary flag)', async () => {
    const res = await validate([
      { wineName: 'Mystery Cuvée', producer: 'Unknown Estate', vintage: '2020' },
    ]);

    expect(res.status).toBe(200);
    const row = res.body.results[0];
    expect(Object.keys(row).sort()).toEqual(['index', 'item', 'matches', 'status']);
    expect(row.status).toBe('ai_match');
    expect(Object.keys(row.matches[0]).sort()).toEqual(
      ['aiIdentified', 'appellation', 'country', 'image', 'name', 'producer', 'region', 'score', 'type', 'wineId'].sort()
    );
    expect(Object.keys(res.body.summary)).toEqual(
      // aiNew joined the summary when /validate went read-only (2026-08-03
      // H-1): AI-identified wines the registry lacks are now proposals, not
      // silent creations — see import.validateReadonly.test.js.
      ['total', 'exact', 'fuzzy', 'aiMatch', 'aiNew', 'noMatch', 'errors', 'priceWarnings']
    );
    expect(res.body.summary.aiBudgetExhausted).toBeUndefined();
  });

  test('a 25-item batch (frontend VALIDATE_BATCH_SIZE) of unknown wines never hits the per-request cap', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      wineName: `Wine ${i}`, producer: `Producer ${i}`, vintage: '2020',
    }));
    const res = await validate(items);

    expect(res.status).toBe(200);
    expect(identifyWineFromText).toHaveBeenCalledTimes(25);
    expect(res.body.results.every(r => r.status === 'ai_match')).toBe(true);
    expect(res.body.results.some(r => r.aiSkipped)).toBe(false);
  });
});

// ── 4. Client disconnect stops NEW launches ──────────────────────────────────

describe('client disconnect', () => {
  async function waitFor(cond, timeoutMs = 3000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
      await new Promise(r => setTimeout(r, 10));
    }
  }

  test('disconnecting mid-fan-out stops launching new AI identifies (and debits)', async () => {
    // 10 unknown unique wines; AI_CONCURRENCY=5 → first wave of 5 launches and
    // blocks; after the client disconnects, the remaining 5 must never launch.
    const resolvers = [];
    identifyWineFromText.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(() => resolve({ data: null, debugRaw: 'x', debugReason: 'ai_unknown: nope' }));
    }));

    const app = buildApp();
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));

    const items = Array.from({ length: 10 }, (_, i) => ({
      wineName: `Ghost ${i}`, producer: `Phantom ${i}`, vintage: '2020',
    }));
    const payload = JSON.stringify({ cellarId: CELLAR_ID, items });
    const req = http.request({
      port: server.address().port,
      path: '/api/bottles/import/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        authorization: `Bearer ${authToken()}`,
      },
    });
    req.on('error', () => {}); // ECONNRESET from our own destroy
    req.on('response', (r) => r.resume());
    req.write(payload);
    req.end();

    try {
      // First concurrency wave in flight
      await waitFor(() => resolvers.length === 5);
      req.destroy();
      // Let the server observe the close event
      await new Promise(r => setTimeout(r, 100));
      // Release the in-flight calls; the workers then pull the remaining
      // tasks, see the disconnect, and skip them.
      for (const fn of resolvers.splice(0)) fn();
      await new Promise(r => setTimeout(r, 200));

      expect(identifyWineFromText).toHaveBeenCalledTimes(5);
      // Debits stopped with the launches (ai_unknown is a completed call — kept)
      expect(userDebits()).toBe(5);
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});
