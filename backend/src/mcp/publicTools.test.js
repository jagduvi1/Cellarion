/**
 * MCP Phase-6 public surface — anonymous-safety invariants.
 *
 * Pins THE property the public endpoint stands on: an anonymous ctx
 * (scopes [], user null) structurally exposes ONLY 'public'-scoped tools —
 * personal tools are unregistered, not hidden. Plus the new public tools'
 * contracts: reviewed-only drink windows (OG-page field boundary, no
 * sommNotes), published-only guides, the anonymous bottle_id guard on
 * find_similar_wines, and zero AI spend (no aiBudget/embedding touched).
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
jest.mock('../models/BlogPost', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Notification', () => ({ find: jest.fn(), countDocuments: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/ClimateDevice', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
// The zero-AI invariant pinned at the RUNTIME boundary (audit P6-L1): if any
// public tool ever reaches the embedding layer, these throw and the happy-path
// tests below fail — regardless of which module the call is laundered through.
jest.mock('../services/embedding', () => ({
  embed: jest.fn(() => { throw new Error('embedding must never run on the public surface'); }),
  embedSingle: jest.fn(() => { throw new Error('embedding must never run on the public surface'); }),
}));
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn(() => { throw new Error('AI budget must never be touched on the public surface'); }),
  tryDebitGlobalAi: jest.fn(() => { throw new Error('AI budget must never be touched on the public surface'); }),
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const BlogPost = require('../models/BlogPost');
const { allTools, toolsForScopes, resourcesForScopes, promptsForScopes } = require('./registry');
require('./tools');
require('./resources'); // resource registration is a side-effect too
require('./prompts');

const oid = (c) => c.repeat(24);
const ANON = { user: null, scopes: [], anonymous: true };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const THIS_YEAR = new Date().getFullYear();

beforeEach(() => jest.clearAllMocks());

describe('the anonymous surface is structural', () => {
  test('scopes [] exposes EXACTLY the public tool set — nothing personal', () => {
    const names = toolsForScopes([], []).map((t) => t.name).sort();
    expect(names).toEqual([
      'drink_window_for', 'find_similar_wines', 'get_source_info', 'get_wine',
      'list_guides', 'read_guide', 'search_registry',
    ]);
  });

  test('every public tool is read-only (the anonymous surface can never mutate)', () => {
    for (const t of toolsForScopes([], [])) {
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  test('anonymous resources = about only; prompts = none', () => {
    expect(resourcesForScopes([]).map((r) => r.uri)).toEqual(['cellarion://about']);
    expect(promptsForScopes([])).toEqual([]);
  });
});

describe('find_similar_wines anonymous guard', () => {
  test('bottle_id without a user → invalid_input pointing at wine_id, before any DB work', async () => {
    const res = await tool('find_similar_wines').handler({ bottle_id: oid('d') }, ANON);
    const body = parse(res);
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/wine_id/);
    const Bottle = require('../models/Bottle');
    expect(Bottle.findById).not.toHaveBeenCalled();
  });
});

describe('drink_window_for', () => {
  const WINE = { _id: new mongoose.Types.ObjectId(oid('f')), name: 'Barolo X', producer: 'P', type: 'red' };

  test('reviewed-only, OG field boundary (no sommNotes), status_now mapping', async () => {
    WineDefinition.findById.mockReturnValue(chain(WINE));
    WineVintageProfile.find.mockReturnValue(chain([
      { vintage: '2015', relative: false, earlyFrom: 2018, earlyUntil: 2021, peakFrom: THIS_YEAR - 2, peakUntil: THIS_YEAR + 3, lateFrom: THIS_YEAR + 4, lateUntil: THIS_YEAR + 8 },
    ]));
    const res = await tool('drink_window_for').handler({ wine_id: oid('f') }, ANON);
    const body = parse(res);
    expect(WineVintageProfile.find).toHaveBeenCalledWith({ wineDefinition: WINE._id, status: 'reviewed' });
    const v = body.data.vintages[0];
    expect(v.status_now).toBe('peak');
    expect(v.unit).toBe('calendar_year');
    expect(v.windows.peak).toEqual({ from: THIS_YEAR - 2, until: THIS_YEAR + 3 });
    expect(JSON.stringify(body)).not.toMatch(/sommNotes/);
  });

  test('relative (NV) profiles report offsets with no now-status', async () => {
    WineDefinition.findById.mockReturnValue(chain(WINE));
    WineVintageProfile.find.mockReturnValue(chain([
      { vintage: 'NV', relative: true, peakFrom: 0, peakUntil: 3 },
    ]));
    const res = await tool('drink_window_for').handler({ wine_id: oid('f') }, ANON);
    const v = parse(res).data.vintages[0];
    expect(v.unit).toBe('years_after_purchase');
    expect(v.status_now).toBeNull();
  });

  test('no curated profile → honest empty with estimate warning; bad/missing wine handled', async () => {
    WineDefinition.findById.mockReturnValue(chain(WINE));
    WineVintageProfile.find.mockReturnValue(chain([]));
    let res = await tool('drink_window_for').handler({ wine_id: oid('f'), vintage: '1999' }, ANON);
    let body = parse(res);
    expect(body.data).toEqual([]);
    expect(body.warnings.join(' ')).toMatch(/estimate/i);

    res = await tool('drink_window_for').handler({ wine_id: 'junk' }, ANON);
    expect(parse(res).error.code).toBe('invalid_input');

    WineDefinition.findById.mockReturnValue(chain(null));
    res = await tool('drink_window_for').handler({ wine_id: oid('9') }, ANON);
    expect(parse(res).error.code).toBe('not_found');
  });
});

describe('guides', () => {
  test('list_guides: published-only filter, tag pass-through, public_url shape', async () => {
    BlogPost.countDocuments.mockResolvedValue(1);
    BlogPost.find.mockReturnValue(chain([
      { slug: 'drink-windows-101', title: 'Drink Windows 101', excerpt: 'x', tags: ['aging'], publishedAt: new Date() },
    ]));
    const res = await tool('list_guides').handler({ tag: 'Aging' }, ANON);
    const body = parse(res);
    expect(BlogPost.find).toHaveBeenCalledWith({ status: 'published', tags: 'aging' });
    expect(body.data[0].public_url).toBe('https://cellarion.app/blog/drink-windows-101');
  });

  test('read_guide: published-only, slug lowercased, truncation warning on huge content', async () => {
    BlogPost.findOne.mockReturnValue(chain({
      slug: 's', title: 'T', excerpt: null, tags: [], publishedAt: new Date(), content: 'x'.repeat(30001),
    }));
    let res = await tool('read_guide').handler({ slug: '  MY-Guide ' }, ANON);
    let body = parse(res);
    expect(BlogPost.findOne).toHaveBeenCalledWith({ slug: 'my-guide', status: 'published' });
    expect(body.data.content).toHaveLength(30000);
    expect(body.warnings.join(' ')).toMatch(/truncated/i);

    BlogPost.findOne.mockReturnValue(chain(null));
    res = await tool('read_guide').handler({ slug: 'draft-post' }, ANON);
    expect(parse(res).error.code).toBe('not_found');
  });
});

describe('zero-AI guarantee', () => {
  test('find_similar_wines full happy path completes without EVER reaching embedding/aiBudget (runtime pin)', async () => {
    // The throwing embedding/aiBudget mocks above are the assertion: if the
    // similarity flow (or anything it calls, e.g. vectorStore) laundered an
    // embed call, this run would throw instead of returning results.
    const WineEmbedding = require('../models/WineEmbedding');
    const vectorStore = require('../services/vectorStore');
    WineEmbedding.findOne.mockReturnValue(chain({ qdrantPointId: 'uuid-1' }));
    vectorStore.getPoints.mockResolvedValue([{ id: 'uuid-1', vector: [0.1, 0.2] }]);
    const other = new mongoose.Types.ObjectId();
    vectorStore.searchSimilar.mockResolvedValue([
      { score: 0.9, payload: { wineDefinitionId: String(other), vintage: '2019' } },
    ]);
    WineDefinition.find.mockReturnValue(chain([{ _id: other, name: 'Similar', producer: 'P', grapes: [] }]));

    const res = await tool('find_similar_wines').handler({ wine_id: oid('f') }, ANON);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(body.data[0].name).toBe('Similar');
    const { embedSingle } = require('../services/embedding');
    const { tryDebitAi } = require('../services/aiBudget');
    expect(embedSingle).not.toHaveBeenCalled();
    expect(tryDebitAi).not.toHaveBeenCalled();
  });

  test('static belt-and-braces: public tool modules never import aiBudget/embedding directly', async () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['tools/wines.js', 'tools/similar.js', 'tools/publicContent.js', 'tools/meta.js']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toMatch(/aiBudget|services\/embedding/);
    }
  });
});

describe('anonymous mutation fail-closed (audit P6-L2) + tighter anon batch budget (P6-L3)', () => {
  const { budgetedHandler } = require('./server');

  test('a hypothetically mis-scoped mutating tool refuses cleanly on the anonymous ctx', async () => {
    const evil = { annotations: { readOnlyHint: false }, handler: jest.fn() };
    const res = await budgetedHandler(evil, { user: null, anonymous: true }, { calls: 0 })({});
    const body = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe('forbidden_scope');
    expect(evil.handler).not.toHaveBeenCalled(); // never runs, never derefs ctx.user
  });

  test('anonymous per-request call budget honours state.max (10) instead of the full 20', async () => {
    const t = { annotations: { readOnlyHint: true }, handler: jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] })) };
    const state = { calls: 0, max: 10 };
    const wrapped = budgetedHandler(t, { user: null, anonymous: true }, state);
    for (let i = 0; i < 10; i++) {
      const r = await wrapped({});
      expect(r.isError).toBeUndefined();
    }
    const over = await wrapped({});
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content[0].text).error.code).toBe('rate_limited');
  });
});
