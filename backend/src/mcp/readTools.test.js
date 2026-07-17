/**
 * Phase-1 MCP read tools — security invariants.
 *
 * WHY THIS TEST EXISTS:
 * Every MCP tool handler receives (args, ctx) and must scope EVERY query to
 * ctx.user — there is no route middleware in front of it. These tests pin the
 * invariants an adversarial caller (or confused AI) would probe: ownership
 * filters present in queries, foreign resources indistinguishable from missing
 * (not_found), PII never serialized (member ids, journal user links, registry
 * internals), and REST privilege parity (registry cap 10, list caps ≤ 50).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.distinct = jest.fn(() => Promise.resolve(result));
  // Thenable: `await Model.findById(id)` (no .lean()) resolves to result too.
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
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
// Lazy-required inside handlers; jest still intercepts by resolved path.
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({
  computeOverview: jest.fn(async () => ({
    overview: { totalBottles: 1 }, byType: [], byCountry: [], byGrape: [],
    topProducers: [], maturity: {}, urgencyLadder: [], pace: {},
  })),
  buildEmptyStats: jest.fn(() => ({ overview: {} })),
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WishlistItem = require('../models/WishlistItem');
const JournalEntry = require('../models/JournalEntry');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');
const { allTools } = require('./registry');
const { budgetedHandler, MAX_CALLS_PER_REQUEST } = require('./server');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const CTX = { user: { id: ME }, scopes: ['read'] };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => {
  jest.clearAllMocks();
  searchService.getIsAvailable.mockReturnValue(false);
});

describe('registration invariants', () => {
  test('every personal-data Phase-1 tool is read-scoped and readOnly-annotated', () => {
    const expected = [
      'list_cellars', 'get_cellar', 'search_bottles', 'get_bottle', 'list_history',
      'list_racks', 'get_rack', 'cellar_stats',
      'list_wishlist', 'list_journal',
    ];
    for (const name of expected) {
      const t = tool(name);
      expect(t).toBeDefined();
      expect(t.scope).toBe('read');
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  test('registry tools are PUBLIC-scoped (shared public-site data — Phase 6 anonymous surface)', () => {
    for (const name of ['search_registry', 'get_wine']) {
      const t = tool(name);
      expect(t.scope).toBe('public');
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
});

describe('ownership scoping', () => {
  test('search_bottles without cellar_id scopes to the user\'s OWNED cellars', async () => {
    Cellar.find.mockReturnValue(chain([oid('c')]));
    Bottle.countDocuments.mockResolvedValue(0);
    Bottle.find.mockReturnValue(chain([]));

    await tool('search_bottles').handler({ status: 'active' }, CTX);

    expect(Cellar.find).toHaveBeenCalledWith({ user: ME, deletedAt: null });
    const filter = Bottle.find.mock.calls[0][0];
    // Deliberately NO user filter: the contract is "bottles in cellars you
    // OWN" (cellar-view semantics), so the Meili and Mongo paths paginate
    // identically — a user filter here could only apply AFTER pagination on
    // the Meili path (page holes / inflated totals).
    expect(filter.user).toBeUndefined();
    expect(filter.cellar).toEqual({ $in: [oid('c')] });
    expect(filter.status).toEqual({ $nin: ['drank', 'gifted', 'sold', 'other'] });
  });

  test('get_cellar on a foreign cellar → not_found (indistinguishable from missing)', async () => {
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('get_cellar').handler({ cellar_id: oid('c') }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('get_bottle in a foreign cellar → not_found', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('get_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
  });

  // REGRESSION (audit HIGH): document refs are ObjectId INSTANCES, not strings.
  // A string-only isValidId gate made get_bottle/get_rack fail on every real
  // call while string-mocked tests stayed green. These success paths use real
  // ObjectIds so that class of bug can never pass the suite again.
  test('get_bottle succeeds on the owner\'s own bottle with a real ObjectId cellar ref', async () => {
    const cellarId = new mongoose.Types.ObjectId(oid('c'));
    Bottle.findById.mockReturnValue(chain({
      _id: oid('d'), cellar: cellarId, vintage: '2015', status: 'active',
      wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'X', grapes: [] },
      pours: [],
    }));
    Cellar.findById.mockReturnValue(chain({ _id: cellarId, user: ME, members: [], deletedAt: null, name: 'Mine' }));
    Rack.findOne.mockReturnValue(chain(null));
    const res = await tool('get_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.data.wine.name).toBe('Barolo');
    expect(body.data.placement).toBeNull();
  });

  test('get_rack succeeds for the owner (ObjectId cellar ref) and hides existence from strangers', async () => {
    const cellarId = new mongoose.Types.ObjectId(oid('c'));
    const fullRack = {
      _id: oid('e'), name: 'Rack A', cellar: cellarId, type: 'grid', rows: 3, cols: 4,
      slots: [{ position: 1, bottle: { _id: oid('d'), vintage: '2015', wineDefinition: { name: 'Barolo', producer: 'X' } } }],
      disabledPositions: [], zones: [],
    };
    // Owner: stub (access probe) then full doc.
    Rack.findOne
      .mockReturnValueOnce(chain({ cellar: cellarId }))
      .mockReturnValueOnce(chain(fullRack));
    Cellar.findById.mockReturnValue(chain({ _id: cellarId, user: ME, members: [], deletedAt: null }));
    const okRes = await tool('get_rack').handler({ rack_id: oid('e') }, CTX);
    expect(okRes.isError).toBeUndefined();
    expect(parse(okRes).data.slots).toHaveLength(1);

    // Oracle check: foreign-but-existing and missing must be indistinguishable.
    Rack.findOne.mockReturnValueOnce(chain({ cellar: cellarId }));
    Cellar.findById.mockReturnValue(chain({ _id: cellarId, user: STRANGER, members: [], deletedAt: null }));
    const foreign = await tool('get_rack').handler({ rack_id: oid('e') }, CTX);
    Rack.findOne.mockReturnValueOnce(chain(null));
    const missing = await tool('get_rack').handler({ rack_id: oid('9') }, CTX);
    expect(foreign.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(parse(foreign).error.message).toBe(parse(missing).error.message);
  });

  test('member (viewer) access to a shared cellar IS allowed', async () => {
    Cellar.findById.mockReturnValue(chain({
      _id: oid('c'), user: STRANGER, members: [{ user: ME, role: 'viewer' }], deletedAt: null, name: 'Shared',
    }));
    Bottle.countDocuments.mockResolvedValue(3);
    Rack.countDocuments.mockResolvedValue(1);
    const res = await tool('get_cellar').handler({ cellar_id: oid('c') }, CTX);
    expect(res.isError).toBeUndefined();
    expect(parse(res).data.role).toBe('viewer');
  });

  test('wishlist and journal queries are keyed to ctx.user', async () => {
    WishlistItem.countDocuments.mockResolvedValue(0);
    WishlistItem.find.mockReturnValue(chain([]));
    await tool('list_wishlist').handler({}, CTX);
    expect(WishlistItem.find.mock.calls[0][0]).toMatchObject({ user: ME, status: 'wanted' });

    JournalEntry.countDocuments.mockResolvedValue(0);
    JournalEntry.find.mockReturnValue(chain([]));
    await tool('list_journal').handler({}, CTX);
    expect(JournalEntry.find.mock.calls[0][0]).toEqual({ user: ME });
  });
});

describe('PII and data minimisation', () => {
  test('get_cellar never serializes member user ids (only a count)', async () => {
    Cellar.findById.mockReturnValue(chain({
      _id: oid('c'), user: ME, members: [{ user: STRANGER, role: 'editor' }], deletedAt: null, name: 'Mine',
    }));
    Bottle.countDocuments.mockResolvedValue(0);
    Rack.countDocuments.mockResolvedValue(0);
    const res = await tool('get_cellar').handler({ cellar_id: oid('c') }, CTX);
    const text = res.content[0].text;
    expect(parse(res).data.member_count).toBe(1);
    expect(text).not.toContain(STRANGER);
  });

  test('list_journal returns people as names only — no linked user ids', async () => {
    JournalEntry.countDocuments.mockResolvedValue(1);
    JournalEntry.find.mockReturnValue(chain([{
      _id: oid('e'), date: new Date(), people: [{ name: 'Anna', user: STRANGER }], pairings: [],
    }]));
    const res = await tool('list_journal').handler({}, CTX);
    expect(parse(res).data[0].people).toEqual(['Anna']);
    expect(res.content[0].text).not.toContain(STRANGER);
  });

  test('search_registry output excludes registry internals (normalizedKey, createdBy)', async () => {
    WineDefinition.find.mockReturnValue(chain([{
      _id: oid('f'), name: 'Barolo', producer: 'X', type: 'red',
      normalizedKey: 'SECRET-KEY', createdBy: STRANGER, grapes: [],
    }]));
    const res = await tool('search_registry').handler({ query: 'barolo' }, CTX);
    expect(res.content[0].text).not.toContain('SECRET-KEY');
    expect(res.content[0].text).not.toContain(STRANGER);
  });
});

describe('privilege parity & bounds', () => {
  test('search_registry via engine is capped at 10 (== REST USER_SEARCH_LIMIT)', async () => {
    searchService.getIsAvailable.mockReturnValue(true);
    searchService.search.mockResolvedValue({ ids: [] });
    WineDefinition.find.mockReturnValue(chain([]));
    await tool('search_registry').handler({ query: 'barolo' }, CTX);
    expect(searchService.search).toHaveBeenCalledWith('barolo', { limit: 10 });
  });

  test('search_bottles clamps an oversized limit to 50', async () => {
    Cellar.find.mockReturnValue(chain([]));
    Bottle.countDocuments.mockResolvedValue(0);
    const q = chain([]);
    Bottle.find.mockReturnValue(q);
    await tool('search_bottles').handler({ limit: 500 }, CTX);
    expect(q.limit).toHaveBeenCalledWith(50);
  });

  test('list_history year filter bounds consumedAt to that calendar year', async () => {
    Cellar.find.mockReturnValue(chain([{ _id: oid('c'), user: ME, members: [] }]));
    Bottle.countDocuments.mockResolvedValue(0);
    Bottle.find.mockReturnValue(chain([]));
    await tool('list_history').handler({ year: 2025 }, CTX);
    const filter = Bottle.find.mock.calls[0][0];
    expect(filter.status).toEqual({ $in: ['drank', 'gifted', 'sold', 'other'] });
    expect(filter.consumedAt.$gte.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(filter.consumedAt.$lt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('search_bottles degrades gracefully when the search engine is down (warning, no text match)', async () => {
    Cellar.find.mockReturnValue(chain([]));
    Bottle.countDocuments.mockResolvedValue(0);
    Bottle.find.mockReturnValue(chain([]));
    const res = await tool('search_bottles').handler({ query: 'barolo' }, CTX);
    const body = parse(res);
    expect(body.warnings.join(' ')).toMatch(/search engine unavailable/i);
  });

  test('search_bottles Meili path hydrates by id only — no post-pagination filters', async () => {
    searchService.getIsAvailable.mockReturnValue(true);
    searchService.searchBottles.mockResolvedValue({ ids: [oid('d')], estimatedTotalHits: 1 });
    Cellar.find.mockReturnValue(chain([oid('c')]));
    Bottle.find.mockReturnValue(chain([]));
    await tool('search_bottles').handler({ query: 'barolo' }, CTX);
    // Scope lives INSIDE the Meili query (owned cellarIds); hydration must not
    // re-filter or pages get holes and totals lie.
    expect(Bottle.find.mock.calls[0][0]).toEqual({ _id: { $in: [oid('d')] } });
    expect(searchService.searchBottles.mock.calls[0][1]).toMatchObject({ cellarIds: [oid('c')] });
  });

  test('per-request tool-call budget rejects call #21 with rate_limited (batch amplification cap)', async () => {
    const t = { name: 'noop', handler: jest.fn(async () => ({ content: [] })) };
    const state = { calls: 0 };
    const wrapped = budgetedHandler(t, CTX, state);
    for (let i = 0; i < MAX_CALLS_PER_REQUEST; i++) {
      await wrapped({});
    }
    const over = await wrapped({});
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content[0].text).error.code).toBe('rate_limited');
    expect(t.handler).toHaveBeenCalledTimes(MAX_CALLS_PER_REQUEST);
  });
});
