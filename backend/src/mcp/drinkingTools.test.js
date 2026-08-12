/**
 * MCP Phase-3 drinking tools — what_should_i_open_tonight / pair_with_dish /
 * semantic_search_wines invariants.
 *
 * Pins: readiness ranking (open bottles first, not-ready excluded), taste +
 * rack-position enrichment on the shortlist only, dish keyword evidence +
 * style-spread fallback, and semantic search's cost rails (per-user embed
 * window → daily AI budget debit → query-vector cache → refund on failure).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1', embeddingModel: 'voyage-4-large' })) }));
jest.mock('../services/aiBudget', () => ({ tryDebitAi: jest.fn() }));
jest.mock('../services/embedding', () => ({ embedSingle: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(async () => ({ rates: {} })),
  convertCurrency: jest.fn((amount) => amount),
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const vectorStore = require('../services/vectorStore');
const { tryDebitAi } = require('../services/aiBudget');
const { embedSingle } = require('../services/embedding');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const ctxFor = (id) => ({ user: { id }, scopes: ['read'] });

const THIS_YEAR = new Date().getFullYear();
const CELLAR_ID = new mongoose.Types.ObjectId(oid('c'));

const mkBottle = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  cellar: CELLAR_ID,
  vintage: '2015',
  status: 'active',
  bottleSize: '750ml',
  wineDefinition: {
    _id: new mongoose.Types.ObjectId(),
    name: 'Wine', producer: 'P', type: 'red',
    grapes: [{ name: 'Nebbiolo' }], region: { name: 'Piedmont' }, country: { name: 'Italy' },
  },
  ...over,
});

function wireCandidates(bottles) {
  Cellar.find.mockReturnValue(chain([{ _id: CELLAR_ID }]));
  Bottle.find.mockReturnValue(chain(bottles));
  WineVintageProfile.find.mockReturnValue(chain([]));
  WineDefinition.find.mockReturnValue(chain([]));
  Rack.find.mockReturnValue(chain([]));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('what_should_i_open_tonight', () => {
  test('ranking: open bottle first, then declining, then peak; not-ready excluded', async () => {
    const open = mkBottle({ openedAt: new Date(), pours: [{ ml: 250 }], drinkTo: THIS_YEAR + 3 });
    const declining = mkBottle({ drinkTo: THIS_YEAR - 1 });
    const peak = mkBottle({ drinkFrom: THIS_YEAR - 2, drinkTo: THIS_YEAR + 2 });
    const notReady = mkBottle({ drinkFrom: THIS_YEAR + 3 });
    wireCandidates([peak, notReady, declining, open]);

    const res = await tool('what_should_i_open_tonight').handler({}, ctxFor(oid('1')));
    const body = parse(res);
    expect(body.data.map((c) => c.readiness)).toEqual(['open', 'declining', 'peak']);
    expect(body.data[0].open.remaining_ml).toBe(500); // 750 − 250 poured
    expect(body.summary).toContain('1 already open');
  });

  test('taste profile and rack position attach to shortlisted bottles only', async () => {
    const b = mkBottle({ drinkTo: THIS_YEAR + 2 });
    wireCandidates([b]);
    WineDefinition.find.mockReturnValue(chain([
      { _id: b.wineDefinition._id, aiProfile: { body: 'full', tannin: 'high', acidity: 'medium', sweetness: 'dry', flavors: ['tar'], foodPairings: ['braised beef'] } },
    ]));
    Rack.find.mockReturnValue(chain([
      { name: 'Rack A', slots: [{ position: 7, bottle: b._id }] },
    ]));
    const res = await tool('what_should_i_open_tonight').handler({}, ctxFor(oid('2')));
    const c = parse(res).data[0];
    expect(c.taste).toMatchObject({ body: 'full', food_pairings: ['braised beef'] });
    expect(c.location).toEqual({ rack: 'Rack A', position: 7 });
    expect(c.wine.grapes).toEqual(['Nebbiolo']);
  });

  test('wine_type filters the pool; max_price drops unpriced bottles with a warning', async () => {
    const cheapRed = mkBottle({ price: 10, currency: 'EUR', drinkTo: THIS_YEAR + 2 });
    const priceyRed = mkBottle({ price: 200, currency: 'EUR', drinkTo: THIS_YEAR + 2 });
    const unpriced = mkBottle({ drinkTo: THIS_YEAR + 2 });
    const white = mkBottle({ price: 5, currency: 'EUR', wineDefinition: { ...mkBottle().wineDefinition, type: 'white' } });
    wireCandidates([cheapRed, priceyRed, unpriced, white]);
    const User = require('../models/User');
    User.findById.mockReturnValue(chain({ preferences: { currency: 'EUR' } }));

    const res = await tool('what_should_i_open_tonight').handler({ wine_type: 'red', max_price: 50 }, ctxFor(oid('3')));
    const body = parse(res);
    expect(body.data).toHaveLength(1);
    expect(String(body.data[0].bottle_id)).toBe(String(cheapRed._id));
    expect(body.warnings.join(' ')).toMatch(/without a comparable price were excluded/);
    // Release-audit M-2: the screened total is the UNFILTERED cellar; the
    // filtered pool is reported separately, never as the total.
    expect(body.summary).toMatch(/^Screened 4 active bottle\(s\) \(1 matched the filters\)/);
  });

  test('foreign cellar_id → not_found', async () => {
    Cellar.findById.mockReturnValue(chain(null));
    const res = await tool('what_should_i_open_tonight').handler({ cellar_id: oid('9') }, ctxFor(oid('4')));
    expect(parse(res).error.code).toBe('not_found');
  });

  test('reserved ("spoken for") bottles never surface as candidates, and the exclusion is disclosed', async () => {
    const reserved = mkBottle({ drinkFrom: THIS_YEAR - 2, drinkTo: THIS_YEAR + 2, reservedFor: "Elias's 18th", reservedUntil: 2034 });
    const reservedYearOnly = mkBottle({ drinkTo: THIS_YEAR - 1, reservedUntil: THIS_YEAR + 8 });
    const free = mkBottle({ drinkFrom: THIS_YEAR - 2, drinkTo: THIS_YEAR + 2 });
    wireCandidates([reserved, reservedYearOnly, free]);

    const res = await tool('what_should_i_open_tonight').handler({}, ctxFor(oid('7')));
    const body = parse(res);
    expect(body.data).toHaveLength(1);
    expect(String(body.data[0].bottle_id)).toBe(String(free._id));
    expect(body.warnings.join(' ')).toMatch(/2 reserved .*excluded/i);
  });

  test('summary leads with the screened cellar total, not just the shortlist (honest scoping)', async () => {
    // 2026-08-12 support ticket "IA bottles known false": a shortlist-only
    // summary was relayed to the user as "the AI only knows 11 of my 72
    // bottles". The screened total — ready or not, reserved included — leads.
    const ready = mkBottle({ drinkFrom: THIS_YEAR - 2, drinkTo: THIS_YEAR + 2 });
    const notReady = mkBottle({ drinkFrom: THIS_YEAR + 3 });
    const reserved = mkBottle({ drinkTo: THIS_YEAR + 2, reservedFor: 'Anna' });
    wireCandidates([ready, notReady, reserved]);
    const res = await tool('what_should_i_open_tonight').handler({}, ctxFor(oid('b')));
    expect(parse(res).summary).toMatch(/^Screened 3 active bottle/);
  });

  test('an all-reserved cellar returns the empty result WITH the reserved disclosure', async () => {
    // Without the warning the model would tell the user "nothing is ready" and
    // never mention that their peak bottles are simply spoken for.
    const reserved = mkBottle({ drinkFrom: THIS_YEAR - 2, drinkTo: THIS_YEAR + 2, reservedFor: 'Anna' });
    wireCandidates([reserved]);
    const res = await tool('what_should_i_open_tonight').handler({}, ctxFor(oid('8')));
    const body = parse(res);
    expect(body.data).toEqual([]);
    expect(body.warnings.join(' ')).toMatch(/1 reserved .*excluded/i);
  });
});

describe('pair_with_dish', () => {
  test('keyword matches carry evidence and outrank; style spread covers the rest', async () => {
    const duckWine = mkBottle({ drinkTo: THIS_YEAR + 2 });
    const other = mkBottle({ drinkTo: THIS_YEAR + 2, wineDefinition: { ...mkBottle().wineDefinition, type: 'white', name: 'Chablis' } });
    wireCandidates([duckWine, other]);
    // First WineDefinition.find call scores pairings; later calls hydrate taste.
    WineDefinition.find.mockReturnValue(chain([
      { _id: duckWine.wineDefinition._id, aiProfile: { foodPairings: ['duck confit', 'game'], flavors: ['cherry'] } },
      { _id: other.wineDefinition._id, aiProfile: { foodPairings: ['oysters'], flavors: ['citrus'] } },
    ]));

    const res = await tool('pair_with_dish').handler({ dish: 'duck confit with lentils' }, ctxFor(oid('5')));
    const body = parse(res);
    expect(body.data.matched).toHaveLength(1);
    expect(String(body.data.matched[0].bottle_id)).toBe(String(duckWine._id));
    expect(body.data.matched[0].match.matched_on).toContain('duck confit');
    expect(body.data.style_spread.length).toBeGreaterThanOrEqual(1); // the Chablis still on the table
  });

  test('no keyword hits → matched empty, style spread still offers candidates', async () => {
    const a = mkBottle({ drinkTo: THIS_YEAR + 2 });
    wireCandidates([a]);
    const res = await tool('pair_with_dish').handler({ dish: 'surströmming' }, ctxFor(oid('6')));
    const body = parse(res);
    expect(body.data.matched).toEqual([]);
    expect(body.data.style_spread).toHaveLength(1);
    expect(body.warnings.join(' ')).toMatch(/hints|evidence/i);
  });

  test('summary states the whole cellar was screened (honest scoping)', async () => {
    const free = mkBottle({ drinkTo: THIS_YEAR + 2 });
    const reserved = mkBottle({ drinkTo: THIS_YEAR + 2, reservedFor: 'the wedding' });
    wireCandidates([free, reserved]);
    const res = await tool('pair_with_dish').handler({ dish: 'roast chicken' }, ctxFor(oid('d')));
    const body = parse(res);
    expect(body.summary).toMatch(/^Screened all 2 active bottle/);
    expect(body.summary).toMatch(/whole cellar was considered/);
  });

  test('reserved bottles are excluded from both the matches and the style spread', async () => {
    const reserved = mkBottle({ drinkTo: THIS_YEAR + 2, reservedFor: 'the wedding' });
    const free = mkBottle({ drinkTo: THIS_YEAR + 2 });
    wireCandidates([reserved, free]);
    const res = await tool('pair_with_dish').handler({ dish: 'roast chicken' }, ctxFor(oid('a')));
    const body = parse(res);
    const allIds = [...body.data.matched, ...body.data.style_spread].map((c) => String(c.bottle_id));
    expect(allIds).toContain(String(free._id));
    expect(allIds).not.toContain(String(reserved._id));
    expect(body.warnings.join(' ')).toMatch(/1 reserved .*excluded/i);
  });
});

describe('semantic_search_wines', () => {
  const HITS = (wineId) => [
    { score: 0.91, payload: { wineDefinitionId: wineId, vintage: '2019' } },
    { score: 0.88, payload: { wineDefinitionId: wineId, vintage: '2020' } }, // same wine — deduped
  ];

  test('budget exhausted → budget_exhausted with recovery guidance, no embed call', async () => {
    tryDebitAi.mockResolvedValue({ ok: false, reason: 'user_budget', retryAfterSeconds: 7200 });
    const res = await tool('semantic_search_wines').handler({ query: 'earthy forest floor' }, ctxFor(oid('1')));
    const body = parse(res);
    expect(body.error.code).toBe('budget_exhausted');
    expect(body.error.message).toMatch(/search_registry/);
    expect(embedSingle).not.toHaveBeenCalled();
  });

  test('happy path: debits once, embeds, dedups vintages to one wine; repeat query hits the cache (no second debit)', async () => {
    const wineId = String(new mongoose.Types.ObjectId());
    tryDebitAi.mockResolvedValue({ ok: true, refund: jest.fn() });
    embedSingle.mockResolvedValue([0.1, 0.2]);
    vectorStore.searchSimilar.mockResolvedValue(HITS(wineId));
    WineDefinition.find.mockReturnValue(chain([
      { _id: wineId, name: 'Barbaresco', producer: 'G', type: 'red', grapes: [] },
    ]));

    const q = 'wet stones and roses';
    const res = await tool('semantic_search_wines').handler({ query: q }, ctxFor(oid('2')));
    const body = parse(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: 'Barbaresco', similarity: 0.91, embedded_vintage: '2019' });
    expect(tryDebitAi).toHaveBeenCalledTimes(1);
    expect(embedSingle).toHaveBeenCalledTimes(1);

    await tool('semantic_search_wines').handler({ query: `  ${q.toUpperCase()}  ` }, ctxFor(oid('2')));
    expect(tryDebitAi).toHaveBeenCalledTimes(1); // normalized cache hit — still one debit
    expect(embedSingle).toHaveBeenCalledTimes(1);
  });

  test('embed failure refunds the debit and reports a retryable outage', async () => {
    const refund = jest.fn();
    tryDebitAi.mockResolvedValue({ ok: true, refund });
    embedSingle.mockRejectedValue(new Error('voyage down'));
    const res = await tool('semantic_search_wines').handler({ query: 'unique failing query' }, ctxFor(oid('3')));
    expect(parse(res).error.code).toBe('unavailable'); // infra down, not the agent's cadence (M3)
    expect(refund).toHaveBeenCalled();
  });

  test('scope mine: restricts the vector search to the user\'s wines; empty cellar short-circuits', async () => {
    tryDebitAi.mockResolvedValue({ ok: true, refund: jest.fn() });
    embedSingle.mockResolvedValue([0.3]);
    Cellar.find.mockReturnValue(chain([{ _id: CELLAR_ID }]));
    const myWine = String(new mongoose.Types.ObjectId());
    Bottle.distinct.mockResolvedValue([myWine]);
    vectorStore.searchSimilar.mockResolvedValue([]);
    await tool('semantic_search_wines').handler({ query: 'silky and light', search_scope: 'mine' }, ctxFor(oid('4')));
    const filterArg = vectorStore.searchSimilar.mock.calls[0][3];
    expect(filterArg.filter.must[0].match.any).toEqual([myWine]);

    Bottle.distinct.mockResolvedValue([]);
    const res = await tool('semantic_search_wines').handler({ query: 'another silky query', search_scope: 'mine' }, ctxFor(oid('5')));
    expect(parse(res).summary).toMatch(/No embedded wines/);
  });

  test('per-user embed window: the 11th new query in a minute is rate_limited before any debit', async () => {
    tryDebitAi.mockResolvedValue({ ok: true, refund: jest.fn() });
    embedSingle.mockResolvedValue([0.5]);
    vectorStore.searchSimilar.mockResolvedValue([]);
    const ctx = ctxFor(oid('6'));
    for (let i = 0; i < 10; i++) {
      const r = await tool('semantic_search_wines').handler({ query: `distinct query number ${i}` }, ctx);
      expect(parse(r).error).toBeUndefined();
    }
    const blocked = await tool('semantic_search_wines').handler({ query: 'query eleven' }, ctx);
    expect(parse(blocked).error.code).toBe('rate_limited');
    expect(tryDebitAi).toHaveBeenCalledTimes(10);
  });
});
