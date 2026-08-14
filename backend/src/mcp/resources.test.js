/**
 * MCP resources + find_similar_wines — security invariants.
 *
 * Same threat model as readTools.test.js: handlers receive ctx directly, so
 * these pin scope gating for resources, ownership checks on the similarity
 * tool, self/dedup behavior of the vector search, and that no internals leak.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.distinct = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({
  computeOverview: jest.fn(async () => ({
    overview: { totalBottles: 2 }, byType: [], byCountry: [], byGrape: [],
    topProducers: [], maturity: {}, urgencyLadder: [], pace: {},
  })),
  buildEmptyStats: jest.fn(() => ({ overview: { totalBottles: 0 } })),
}));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const vectorStore = require('../services/vectorStore');
const { allTools, allResources, allPrompts, resourcesForScopes } = require('./registry');
const { budgetedResourceHandler, MAX_CALLS_PER_REQUEST } = require('./server');
require('./tools');
require('./prompts');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const CTX = { user: { id: ME }, scopes: ['read'] };

const tool = (name) => allTools().find((t) => t.name === name);
const resource = (name) => allResources().find((r) => r.name === name);
const parseTool = (res) => JSON.parse(res.content[0].text);
const parseResource = (res) => JSON.parse(res.contents[0].text);

beforeEach(() => jest.clearAllMocks());

describe('resource registration + scope gating', () => {
  test('the four Phase-1 resources are registered with the right scopes', () => {
    expect(resource('about').scope).toBe('public');
    for (const name of ['cellar-snapshot', 'cellar-stats', 'bottle-dossier']) {
      expect(resource(name).scope).toBe('read');
    }
    expect(resource('bottle-dossier').uriTemplate).toBe('cellar://bottle/{id}');
  });

  test('a zero-scope token sees only public resources', () => {
    const names = resourcesForScopes([]).map((r) => r.name);
    expect(names).toContain('about');
    expect(names).not.toContain('cellar-snapshot');
    expect(names).not.toContain('cellar-stats');
    expect(names).not.toContain('bottle-dossier');
  });
});

describe('resource handlers', () => {
  test('about is static, mentions the repo + licence, leaks no env/secrets', async () => {
    const res = await resource('about').handler('cellarion://about', {}, CTX);
    const text = res.contents[0].text;
    expect(text).toContain('github.com/jagduvi1/Cellarion');
    expect(text).toContain('AGPL-3.0');
    expect(text).not.toMatch(/process\.env|secret|password|mongodb:\/\//i);
  });

  test('cellar-snapshot scopes to accessible cellars and returns counts only', async () => {
    Cellar.find.mockReturnValue(chain([{ _id: oid('c'), user: ME, members: [{ user: STRANGER, role: 'editor' }], name: 'Mine' }]));
    Bottle.aggregate
      .mockResolvedValueOnce([{ _id: oid('c'), n: 4 }])
      .mockResolvedValueOnce([{ _id: oid('c'), n: 2 }]);
    const res = await resource('cellar-snapshot').handler('cellar://snapshot', {}, CTX);
    const body = parseResource(res);
    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: ME }, { 'members.user': ME }], deletedAt: null });
    expect(body.data[0]).toMatchObject({ name: 'Mine', role: 'owner', active_bottles: 4, consumed_bottles: 2 });
    // Member ids never serialize in the snapshot.
    expect(res.contents[0].text).not.toContain(STRANGER);
  });

  test('bottle-dossier on a foreign bottle returns an error body, not data', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await resource('bottle-dossier').handler('cellar://bottle/' + oid('d'), { id: oid('d') }, CTX);
    expect(parseResource(res).error.code).toBe('not_found');
  });

  test('resource reads share the per-request call budget (over budget throws)', () => {
    const r = { name: 'x', uri: 'x://y', handler: jest.fn() };
    const state = { calls: MAX_CALLS_PER_REQUEST };
    expect(() => budgetedResourceHandler(r, CTX, state)('x://y', {})).toThrow(/rate_limited/);
    expect(r.handler).not.toHaveBeenCalled();
  });
});

describe('find_similar_wines', () => {
  test('foreign bottle_id → not_found before any vector work', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c'), wineDefinition: oid('f') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('find_similar_wines').handler({ bottle_id: oid('d') }, CTX);
    expect(res.isError).toBe(true);
    expect(vectorStore.getPoints).not.toHaveBeenCalled();
  });

  test('un-embedded wine → graceful empty with guidance, no vector calls', async () => {
    WineEmbedding.findOne.mockReturnValue(chain(null));
    const res = await tool('find_similar_wines').handler({ wine_id: oid('f') }, CTX);
    const body = parseTool(res);
    expect(body.data).toEqual([]);
    expect(body.warnings.join(' ')).toMatch(/not been embedded/i);
    expect(vectorStore.getPoints).not.toHaveBeenCalled();
  });

  test('excludes the reference wine, dedups vintages keeping best score, hydrates in rank order', async () => {
    const REF = oid('f');
    const W2 = oid('1');
    const W3 = oid('2');
    WineEmbedding.findOne.mockReturnValue(chain({ qdrantPointId: 'uuid-1' }));
    vectorStore.getPoints.mockResolvedValue([{ id: 'uuid-1', vector: [0.1, 0.2] }]);
    vectorStore.searchSimilar.mockResolvedValue([
      { score: 0.99, payload: { wineDefinitionId: REF, vintage: '2015' } }, // self — dropped
      { score: 0.95, payload: { wineDefinitionId: W2, vintage: '2016' } },
      { score: 0.93, payload: { wineDefinitionId: W2, vintage: '2018' } }, // dup wine — dropped
      { score: 0.90, payload: { wineDefinitionId: W3, vintage: 'NV' } },
    ]);
    WineDefinition.find.mockReturnValue(chain([
      { _id: W2, name: 'Wine Two', producer: 'P2', grapes: [], normalizedKey: 'INTERNAL' },
      { _id: W3, name: 'Wine Three', producer: 'P3', grapes: [] },
    ]));
    const res = await tool('find_similar_wines').handler({ wine_id: REF }, CTX);
    const body = parseTool(res);
    expect(body.data.map((w) => w.name)).toEqual(['Wine Two', 'Wine Three']);
    expect(body.data[0].similarity).toBe(0.95);
    expect(res.content[0].text).not.toContain(REF);       // reference excluded
    expect(res.content[0].text).not.toContain('INTERNAL'); // registry internals never serialize
  });

  test('is PUBLIC-scoped ($0 stored-vector lookup — Phase 6 anonymous surface) + readOnly, and limit is clamped to 10', async () => {
    const t = tool('find_similar_wines');
    expect(t.scope).toBe('public');
    expect(t.annotations.readOnlyHint).toBe(true);
    WineEmbedding.findOne.mockReturnValue(chain({ qdrantPointId: 'uuid-1' }));
    vectorStore.getPoints.mockResolvedValue([{ id: 'uuid-1', vector: [0.1] }]);
    vectorStore.searchSimilar.mockResolvedValue([]);
    await t.handler({ wine_id: oid('f'), limit: 500 }, CTX);
    // over-fetch is (limit+1)*5 with limit clamped to 10 → 55
    expect(vectorStore.searchSimilar).toHaveBeenCalledWith('v1', [0.1], 55);
  });

  // The clamp above is only REACHED if the registered schema lets the call
  // through. It used to be z.number().int().min(1).max(10), so in production
  // the SDK rejected `limit: 500` with -32602 before the handler ran — while
  // this suite, which calls handlers directly, proved the unreachable clamp
  // green. Prod counted 51 such refusals on the anonymous surface. Assert the
  // SCHEMA is permissive, not just the handler.
  test('limit schema accepts out-of-range and string numbers so the handler can clamp them', () => {
    const { z } = require('zod');
    const schema = z.object(tool('find_similar_wines').inputSchema);
    expect(schema.safeParse({ wine_id: oid('f'), limit: 500 }).success).toBe(true);
    expect(schema.safeParse({ wine_id: oid('f'), limit: '5' }).success).toBe(true);
    expect(schema.safeParse({ wine_id: oid('f') }).success).toBe(true);
  });
});

// ── Coverage added by the 2026-07-16 refactor audit ──────────────────────────

describe('previously-uncovered handlers', () => {
  const User = require('../models/User');
  const Rack = require('../models/Rack');
  const { INSTRUCTIONS } = require('./instructions');

  test('cellar_stats: empty case keeps the envelope (uncached), currency preference uppercased', async () => {
    User.findById.mockReturnValue(chain({ preferences: { currency: 'sek', ratingScale: '5' } }));
    Cellar.find.mockReturnValue(chain([]));
    const res = await tool('cellar_stats').handler({}, { user: { id: oid('9') }, scopes: ['read'] });
    const body = parseTool(res);
    expect(body.data.currency).toBe('SEK');           // preference uppercased
    expect(body.data.by_type).toEqual({});            // object map, same as populated shape
    expect(body.data.overview).toBeDefined();
  });

  test('cellar_stats: populated result is cached for the TTL (no recompute on repeat call)', async () => {
    User.findById.mockReturnValue(chain({ preferences: { currency: 'EUR' } }));
    Cellar.find.mockReturnValue(chain([{ _id: oid('c'), user: oid('6') }]));
    Bottle.find.mockReturnValue(chain([]));
    await tool('cellar_stats').handler({}, { user: { id: oid('6') }, scopes: ['read'] });

    // Second call within TTL: served from cache — no cellar/bottle queries.
    Cellar.find.mockClear();
    Bottle.find.mockClear();
    const res = await tool('cellar_stats').handler({}, { user: { id: oid('6') }, scopes: ['read'] });
    expect(Cellar.find).not.toHaveBeenCalled();
    expect(Bottle.find).not.toHaveBeenCalled();
    expect(parseTool(res).data.currency).toBe('EUR');
  });

  test('cellar://stats resource returns {summary, data, warnings?} (tool-envelope parity)', async () => {
    User.findById.mockReturnValue(chain({ preferences: {} }));
    Cellar.find.mockReturnValue(chain([]));
    const res = await resource('cellar-stats').handler('cellar://stats', {}, { user: { id: oid('8') }, scopes: ['read'] });
    const body = parseResource(res);
    expect(body.summary).toBeDefined();
    expect(body.data.currency).toBe('USD');
    expect(body.cellars).toBeUndefined(); // one envelope convention everywhere
  });

  test('get_wine: invalid id → invalid_input; skeleton aiProfile serializes as null; public_url from slug', async () => {
    const WineDefinition = require('../models/WineDefinition');
    const bad = await tool('get_wine').handler({ wine_id: 'nope' }, CTX);
    expect(JSON.parse(bad.content[0].text).error.code).toBe('invalid_input');

    WineDefinition.findOne.mockReturnValue(chain({
      _id: oid('f'), name: 'Barolo', producer: 'X', slug: 'barolo-x', grapes: [],
      aiProfile: { body: null, acidity: null, notes: [] }, communityRating: { averageNormalized: null, reviewCount: 0 },
    }));
    const res = await tool('get_wine').handler({ wine_id: oid('f') }, CTX);
    const body = parseTool(res);
    expect(body.data.tasting_profile).toBeNull();
    expect(body.data.community_rating).toBeNull();
    expect(body.data.public_url).toBe('https://cellarion.app/wines/barolo-x');
  });

  test('list_racks: modular racks report null rows/cols + module count; capacity honors disabled positions', async () => {
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
    Rack.find.mockReturnValue(chain([
      { _id: oid('e'), name: 'Grid', type: 'grid', rows: 3, cols: 4, slots: [{}], disabledPositions: [1, 2], zones: [] },
      { _id: oid('7'), name: 'Mod', isModular: true, rows: 4, cols: 8, modules: [{}, {}], slots: [], zones: [] },
    ]));
    const res = await tool('list_racks').handler({ cellar_id: oid('c') }, CTX);
    const body = parseTool(res);
    expect(body.data[0]).toMatchObject({ capacity: 10, filled: 1, free: 9 }); // getMaxPosition mocked to 12, minus 2 disabled
    expect(body.data[1]).toMatchObject({ type: 'modular', rows: null, cols: null, modules: 2 });
  });

  test('instructions drift guard: every tool name, resource URI and prompt name is mentioned', () => {
    for (const t of allTools()) {
      expect(INSTRUCTIONS).toContain(t.name);
    }
    for (const r of allResources()) {
      expect(INSTRUCTIONS).toContain(r.uri || r.uriTemplate);
    }
    for (const p of allPrompts()) {
      expect(INSTRUCTIONS).toContain(p.name);
    }
  });

  test('public-instructions drift guard: every anonymous-surface tool is mentioned there too', () => {
    const { PUBLIC_INSTRUCTIONS } = require('./instructions');
    for (const t of allTools().filter((x) => x.scope === 'public')) {
      expect(PUBLIC_INSTRUCTIONS).toContain(t.name);
    }
  });
});
