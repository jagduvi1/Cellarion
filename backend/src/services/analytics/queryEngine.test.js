/**
 * The analytics query engine (#987 Phase 0) — the four correctness traps,
 * the security boundary, and the bounds, pinned at the unit level.
 *
 * The rating/currency parity tests run the GENERATED aggregation expressions
 * through a tiny evaluator and compare against the real JS helpers
 * (toNormalized / convertCurrency) — if the expression generator ever drifts
 * from the shared anchor table or rates math, these fail.
 */

jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), find: jest.fn() }));
jest.mock('../../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataEntry', () => ({ find: jest.fn() }));
jest.mock('../../models/RegistryDataValue', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/RegistryDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(async () => ({ rates: { USD: 1, EUR: 0.9, SEK: 10 } })),
  convertCurrency: jest.requireActual('../../utils/exchangeRates').convertCurrency,
}));
jest.mock('../../utils/maturityUtils', () => ({
  classifyMaturity: jest.fn(() => 'ready'),
  buildProfileMap: jest.fn(async () => new Map()),
}));

const mongoose = require('mongoose');
const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const PersonalDataKey = require('../../models/PersonalDataKey');
const { toNormalized } = require('../../utils/ratingUtils');
const { convertCurrency } = require('../../utils/exchangeRates');
const {
  runQuery, QueryError, compileFilters, normalizedRatingExpr, convertedPriceExpr,
  MAX_TIME_MS, ROWS_LIMIT_MAX, BUCKET_CAP,
} = require('./queryEngine');

const USER = 'a'.repeat(24);
const CELLAR_A = 'b'.repeat(24);
const CELLAR_B = 'c'.repeat(24);

// ── mock chain helpers ─────────────────────────────────────────────────────

const chainLean = (docs) => {
  const c = {};
  for (const m of ['select', 'limit', 'sort', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => docs);
  return c;
};
const aggReturning = (result) => {
  const captured = { pipelines: [], options: [] };
  Bottle.aggregate.mockImplementation((pipeline) => {
    captured.pipelines.push(pipeline);
    return { option: jest.fn(async (opts) => { captured.options.push(opts); return result; }) };
  });
  return captured;
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue(chainLean([
    { _id: CELLAR_A, name: 'Home' },
    { _id: CELLAR_B, name: 'Shared' },
  ]));
});

// ── generated-expression parity ────────────────────────────────────────────

/** Minimal evaluator for the expression subset the generators emit. */
function evalExpr(expr, doc) {
  if (expr === null || typeof expr === 'number' || typeof expr === 'string' || typeof expr === 'boolean') {
    if (typeof expr === 'string' && expr.startsWith('$')) {
      const v = expr.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
      return v === undefined ? null : v;
    }
    return expr;
  }
  const [op] = Object.keys(expr);
  const a = expr[op];
  switch (op) {
    case '$cond': return evalExpr(a[0], doc) ? evalExpr(a[1], doc) : evalExpr(a[2], doc);
    case '$or': return a.some((x) => evalExpr(x, doc));
    case '$eq': return evalExpr(a[0], doc) === evalExpr(a[1], doc);
    case '$lte': return evalExpr(a[0], doc) <= evalExpr(a[1], doc);
    case '$type': { const v = evalExpr(a, doc); return v === null ? 'null' : v === undefined ? 'missing' : typeof v; }
    case '$add': return a.reduce((s, x) => s + evalExpr(x, doc), 0);
    case '$subtract': return evalExpr(a[0], doc) - evalExpr(a[1], doc);
    case '$multiply': return a.reduce((p, x) => p * evalExpr(x, doc), 1);
    case '$divide': return evalExpr(a[0], doc) / evalExpr(a[1], doc);
    case '$switch': {
      for (const b of a.branches) if (evalExpr(b.case, doc)) return evalExpr(b.then, doc);
      return evalExpr(a.default, doc);
    }
    default: throw new Error(`evaluator: unhandled ${op}`);
  }
}

describe('normalizedRatingExpr parity with toNormalized', () => {
  const expr = normalizedRatingExpr('rating', 'ratingScale');
  const sweep = {
    '5': [1, 1.7, 2.5, 3, 3.4, 4, 4.5, 4.9, 5],
    '20': [1, 8, 11.5, 14.5, 16, 18, 19.5, 20],
    '100': [50, 60, 75, 82, 86, 90, 96, 100],
  };
  for (const [scale, values] of Object.entries(sweep)) {
    test(`scale ${scale}: pipeline expression matches the JS helper`, () => {
      for (const v of values) {
        const got = evalExpr(expr, { rating: v, ratingScale: scale });
        expect(got).toBeCloseTo(toNormalized(v, scale), 6);
      }
    });
  }
  test('a missing rating evaluates to null, never 0', () => {
    expect(evalExpr(expr, { ratingScale: '5' })).toBeNull();
    expect(evalExpr(expr, { rating: null, ratingScale: '100' })).toBeNull();
  });
});

describe('convertedPriceExpr parity with convertCurrency', () => {
  const rates = { USD: 1, EUR: 0.9, SEK: 10 };
  const { expr } = convertedPriceExpr('price', 'currency', rates, 'SEK');
  test.each([
    [100, 'EUR'], [100, 'USD'], [250, 'SEK'],
  ])('%p %s converts identically to convertCurrency', (amount, from) => {
    expect(evalExpr(expr, { price: amount, currency: from }))
      .toBeCloseTo(convertCurrency(amount, from, 'SEK', rates), 6);
  });
  test('an unknown currency yields null (counted, not silently zeroed)', () => {
    expect(evalExpr(expr, { price: 100, currency: 'XXX' })).toBeNull();
  });
  test('a missing price yields null', () => {
    expect(evalExpr(expr, { currency: 'EUR' })).toBeNull();
  });
  test('no rates for the target → no expression at all', () => {
    expect(convertedPriceExpr('price', 'currency', null, 'SEK').expr).toBeNull();
    expect(convertedPriceExpr('price', 'currency', { USD: 1 }, 'SEK').expr).toBeNull();
  });
});

// ── the security boundary ──────────────────────────────────────────────────

describe('filter compilation is a whitelist, not an interpreter', () => {
  test('an unknown field is rejected', async () => {
    await expect(compileFilters([{ field: 'evil.$where', op: 'eq', value: 1 }], USER))
      .rejects.toThrow(/Unknown field/);
  });
  test('an operator outside the type whitelist is rejected', async () => {
    await expect(compileFilters([{ field: 'wine.producer', op: 'contains_regex', value: 'x' }], USER))
      .rejects.toThrow(/not allowed|Unknown operator/);
  });
  test('an object where text is expected is rejected, not stringified', async () => {
    await expect(compileFilters([{ field: 'wine.producer', op: 'eq', value: { $ne: null } }], USER))
      .rejects.toThrow(/expected text/);
  });
  test('regex metacharacters in contains are escaped literally', async () => {
    const { post } = await compileFilters([{ field: 'wine.producer', op: 'contains', value: 'a.b*' }], USER);
    expect(post[0]['wd.producer'].$regex).toBe('a\\.b\\*');
  });
  test('enum values outside the declared options are rejected', async () => {
    await expect(compileFilters([{ field: 'bottle.status', op: 'eq', value: 'hacked' }], USER))
      .rejects.toThrow(/expected one of/i);
  });
  test('between takes exactly [min, max]', async () => {
    await expect(compileFilters([{ field: 'purchase.price', op: 'between', value: [1] }], USER))
      .rejects.toThrow(/\[min, max\]/);
  });
  test('a valid bottle filter compiles to a pre-lookup condition', async () => {
    const { pre, post, needsWine } = await compileFilters(
      [{ field: 'purchase.price', op: 'between', value: [100, 500] }], USER
    );
    expect(pre).toEqual([{ price: { $gte: 100, $lte: 500 } }]);
    expect(post).toEqual([]);
    expect(needsWine).toBe(false);
  });
  test('a wine-field filter lands post-lookup and flags needsWine', async () => {
    const { pre, post, needsWine } = await compileFilters(
      [{ field: 'wine.producer', op: 'contains', value: 'niepoort' }], USER
    );
    expect(pre).toEqual([]);
    expect(post[0]['wd.producer']).toBeDefined();
    expect(needsWine).toBe(true);
  });
});

// ── KV filters resolve entries first ───────────────────────────────────────

describe('personal key/value filters', () => {
  const KEY_ID = 'd'.repeat(24);
  beforeEach(() => {
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: KEY_ID, user: USER, name: 'ABV', type: 'decimal', unit: '%' }),
    });
  });

  test('entries narrow the bottle match: bottle-level ids OR wine-level (with vintage scope)', async () => {
    PersonalDataEntry.find.mockReturnValue(chainLean([
      { targetType: 'bottle', bottle: 'e'.repeat(24) },
      { targetType: 'wine', wineDefinition: 'f'.repeat(24), vintage: '2019' },
      { targetType: 'wine', wineDefinition: '1'.repeat(24), vintage: null },
    ]));
    const { pre } = await compileFilters(
      [{ field: `personal.${KEY_ID}`, op: 'gte', value: 14 }], USER
    );
    expect(pre[0].$or).toEqual([
      { _id: { $in: ['e'.repeat(24)] } },
      { wineDefinition: 'f'.repeat(24), vintage: '2019' },
      { wineDefinition: '1'.repeat(24) },
    ]);
    // The entry query was value-predicated and author-scoped.
    expect(PersonalDataEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ author: USER, key: KEY_ID, value: { $gte: 14 } })
    );
  });

  test('no matching entries → a match-nothing condition, not an error', async () => {
    PersonalDataEntry.find.mockReturnValue(chainLean([]));
    const { pre } = await compileFilters(
      [{ field: `personal.${KEY_ID}`, op: 'gte', value: 99 }], USER
    );
    expect(pre[0]).toEqual({ _id: { $in: [] } });
  });

  test('a KV value failing the key type is rejected with the key label', async () => {
    await expect(compileFilters(
      [{ field: `personal.${KEY_ID}`, op: 'eq', value: 'not-a-number' }], USER
    )).rejects.toThrow(/ABV/);
  });

  test("another user's personal key id resolves like a key that does not exist", async () => {
    PersonalDataKey.findOne.mockReturnValue({ lean: async () => null }); // ownership check missed
    await expect(compileFilters(
      [{ field: `personal.${KEY_ID}`, op: 'eq', value: 1 }], USER
    )).rejects.toThrow(/Unknown field/);
  });
});

// ── scope ──────────────────────────────────────────────────────────────────

describe('scope derivation', () => {
  const emptyRows = () => aggReturning([{ ids: [], total: [] }]);

  test('the first $match is always the derived cellar scope + active status by default', async () => {
    const cap = emptyRows();
    const out = await runQuery(USER, {});
    const first = cap.pipelines[0][0].$match;
    expect(first.cellar.$in.map(String)).toEqual([CELLAR_A, CELLAR_B]);
    expect(first.status).toBe('active');
    expect(out.scope.bottles).toBe('active');
    expect(out.scope.cellars.map((c) => c.name)).toEqual(['Home', 'Shared']);
  });

  test('a client cellar list can only narrow, and an out-of-scope id narrows to nothing → 400', async () => {
    emptyRows();
    const out = await runQuery(USER, { scope: { cellars: [CELLAR_A] } });
    expect(out.scope.cellars.map((c) => c.name)).toEqual(['Home']);
    await expect(runQuery(USER, { scope: { cellars: ['9'.repeat(24)] } }))
      .rejects.toThrow(/matched none/);
  });

  test('consumed scope filters to the consumed statuses and says so in the envelope', async () => {
    const cap = emptyRows();
    const out = await runQuery(USER, { scope: { bottles: 'consumed' } });
    expect(cap.pipelines[0][0].$match.status).toEqual({ $in: ['drank', 'gifted', 'sold', 'other'] });
    expect(out.scope.bottles).toBe('consumed');
  });

  test('an invalid bottle scope is rejected', async () => {
    await expect(runQuery(USER, { scope: { bottles: 'everything' } }))
      .rejects.toThrow(/active, consumed or all/);
  });
});

// ── bounds ─────────────────────────────────────────────────────────────────

describe('bounds and caps', () => {
  test('every aggregation runs under maxTimeMS', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, {});
    expect(cap.options.every((o) => o.maxTimeMS === MAX_TIME_MS)).toBe(true);
  });

  test('rows limit clamps to the hard cap and reports what it used', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    const out = await runQuery(USER, { limit: 99999 });
    const facet = cap.pipelines[0].find((s) => s.$facet);
    expect(facet.$facet.ids[1].$limit).toBe(ROWS_LIMIT_MAX);
    expect(out.page.limit).toBe(ROWS_LIMIT_MAX);
  });

  test('sort always carries the _id tiebreaker', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, { sort: { field: 'purchase.price', dir: 'desc' } });
    const sort = cap.pipelines[0].find((s) => s.$sort).$sort;
    expect(sort).toEqual({ price: -1, _id: 1 });
  });

  test('a non-sortable field is refused as a sort, honestly (grapes is an array ref)', async () => {
    await expect(runQuery(USER, { sort: { field: 'wine.grapes', dir: 'asc' } }))
      .rejects.toThrow(/not sortable/);
  });

  test('R-B: a taxonomy sort joins the name collection and sorts by it, tiebroken', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, { sort: { field: 'wine.country', dir: 'asc' } });
    const p = cap.pipelines[0];
    const lookup = p.find((s) => s.$lookup && s.$lookup.from === 'countries');
    expect(lookup.$lookup.localField).toBe('wd.country');
    expect(p.find((s) => s.$sort).$sort).toEqual({ _sortVal: 1, _id: 1 });
    // The wine lookup precedes the taxonomy join.
    expect(p.findIndex((s) => s.$lookup && s.$lookup.from === 'winedefinitions'))
      .toBeLessThan(p.findIndex((s) => s.$lookup && s.$lookup.from === 'countries'));
  });

  test('R-B: a personal KV sort joins entries with the bottle>vintage>null precedence', async () => {
    const KEY_ID = 'd'.repeat(24);
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: KEY_ID, user: USER, name: 'ABV', type: 'decimal', unit: '%' }),
    });
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, { sort: { field: `personal.${KEY_ID}`, dir: 'desc' } });
    const p = cap.pipelines[0];
    const lookup = p.find((s) => s.$lookup && s.$lookup.from === 'personaldataentries');
    expect(lookup).toBeDefined();
    const inner = lookup.$lookup.pipeline;
    // Precedence is enforced INSIDE the sub-pipeline: prio sort then limit 1.
    expect(inner.find((s) => s.$sort)).toEqual({ $sort: { _prio: 1 } });
    expect(inner.find((s) => s.$limit)).toEqual({ $limit: 1 });
    expect(p.find((s) => s.$sort && s.$sort._sortVal !== undefined).$sort).toEqual({ _sortVal: -1, _id: 1 });
  });

  test('grouped mode refuses a third dimension', async () => {
    await expect(runQuery(USER, {
      mode: 'grouped',
      dimensions: ['bottle.status', 'wine.type', 'bottle.vintage'],
      measures: [{ field: '*', agg: 'count' }],
    })).rejects.toThrow(/1–2 dimensions/);
  });

  test('grouped mode reports the bucket cap when it fires', async () => {
    const rows = Array.from({ length: BUCKET_CAP + 1 }, (_, i) => ({ _id: { d0: `v${i}` }, m0: 1 }));
    aggReturning(rows);
    const out = await runQuery(USER, {
      mode: 'grouped', dimensions: ['bottle.vintage'], measures: [{ field: '*', agg: 'count' }],
    });
    expect(out.buckets).toHaveLength(BUCKET_CAP);
    expect(out.capped).toEqual({ type: 'buckets', at: BUCKET_CAP });
  });

  test('a NUMERIC KV field stays refused as a grouped dimension — every reading would be a bucket', async () => {
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: 'd'.repeat(24), user: USER, name: 'ABV', type: 'decimal' }),
    });
    await expect(runQuery(USER, {
      mode: 'grouped', dimensions: [`personal.${'d'.repeat(24)}`], measures: [{ field: '*', agg: 'count' }],
    })).rejects.toThrow(/cannot be grouped/);
  });

  test('R-B: an ENUM KV field groups by its joined value', async () => {
    const KEY_ID = 'd'.repeat(24);
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: KEY_ID, user: USER, name: 'Source', type: 'enum', enumOptions: ['shop', 'auction'] }),
    });
    const cap = aggReturning([{ _id: { d0: 'shop' }, m0: 4 }, { _id: { d0: 'auction' }, m0: 2 }]);
    const out = await runQuery(USER, {
      mode: 'grouped', dimensions: [`personal.${KEY_ID}`], measures: [{ field: '*', agg: 'count' }],
    });
    const p = cap.pipelines[0];
    expect(p.find((s) => s.$lookup && s.$lookup.from === 'personaldataentries')).toBeDefined();
    expect(p.find((s) => s.$group).$group._id).toEqual({ d0: '$_d0v' });
    expect(out.buckets).toEqual([
      { dimensions: ['shop'], measures: [4] },
      { dimensions: ['auction'], measures: [2] },
    ]);
  });

  test('R-B: a numeric KV MEASURE aggregates the joined value behind an $isNumber guard', async () => {
    const KEY_ID = 'd'.repeat(24);
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: KEY_ID, user: USER, name: 'ABV', type: 'decimal', unit: '%' }),
    });
    const cap = aggReturning([{ _id: { d0: 'red' }, m0: 3, m1: 13.8 }]);
    const out = await runQuery(USER, {
      mode: 'grouped', dimensions: ['wine.type'],
      measures: [{ field: '*', agg: 'count' }, { field: `personal.${KEY_ID}`, agg: 'avg' }],
    });
    const p = cap.pipelines[0];
    const group = p.find((s) => s.$group).$group;
    expect(group.m1.$avg).toEqual({ $cond: [{ $isNumber: '$_m1v' }, '$_m1v', null] });
    expect(out.measureLabels[1]).toBe('avg(ABV)');
    expect(out.buckets[0].measures).toEqual([3, 13.8]);
  });
});

// ── rows hydration ─────────────────────────────────────────────────────────

describe('rows mode hydration', () => {
  const B1 = 'e'.repeat(24);
  const W1 = 'f'.repeat(24);

  test('page rows carry the requested columns, with taxonomy names and personal precedence', async () => {
    aggReturning([{ ids: [{ _id: B1 }], total: [{ n: 1 }] }]);
    Bottle.find.mockReturnValue(chainLean([{
      _id: B1, cellar: CELLAR_A, vintage: '2019', price: 250, currency: 'SEK',
      wineDefinition: {
        _id: W1, producer: 'Niepoort', name: 'Redoma',
        country: { name: 'Portugal' }, region: { name: 'Douro' },
        grapes: [{ name: 'Touriga Franca' }, { name: 'Tinta Roriz' }],
      },
    }]));
    const KEY_ID = 'd'.repeat(24);
    PersonalDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: KEY_ID, user: USER, name: 'ABV', type: 'decimal', unit: '%' }),
    });
    // Both a wine-null and a wine-vintage entry exist — vintage-scoped wins.
    PersonalDataEntry.find.mockReturnValue(chainLean([
      { key: KEY_ID, targetType: 'wine', wineDefinition: W1, vintage: null, value: 13.5 },
      { key: KEY_ID, targetType: 'wine', wineDefinition: W1, vintage: '2019', value: 14.1 },
    ]));

    const out = await runQuery(USER, {
      columns: ['wine.producer', 'wine.country', 'wine.grapes', 'bottle.cellar', 'purchase.price', `personal.${KEY_ID}`],
    });
    expect(out.total).toBe(1);
    expect(out.rows[0].values).toEqual({
      'wine.producer': 'Niepoort',
      'wine.country': 'Portugal',
      'wine.grapes': ['Touriga Franca', 'Tinta Roriz'],
      'bottle.cellar': 'Home',
      'purchase.price': 250,
      [`personal.${KEY_ID}`]: 14.1,
    });
  });

  test('a registry value hydrates from the published row only', async () => {
    aggReturning([{ ids: [{ _id: B1 }], total: [{ n: 1 }] }]);
    Bottle.find.mockReturnValue(chainLean([{ _id: B1, cellar: CELLAR_A, wineDefinition: { _id: W1 } }]));
    const RKEY = '2'.repeat(24);
    const RegistryDataKey = require('../../models/RegistryDataKey');
    RegistryDataKey.findOne.mockReturnValue({
      lean: async () => ({ _id: RKEY, name: 'ABV', type: 'decimal', unit: '%', status: 'accepted' }),
    });
    RegistryDataValue.find.mockReturnValue(chainLean([
      { key: RKEY, wineDefinition: W1, value: 13.0, status: 'published' },
    ]));
    const out = await runQuery(USER, { columns: [`registry.${RKEY}`] });
    expect(out.rows[0].values[`registry.${RKEY}`]).toBe(13.0);
    expect(RegistryDataValue.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published' })
    );
  });

  test('a blank value is null, not omitted', async () => {
    aggReturning([{ ids: [{ _id: B1 }], total: [{ n: 1 }] }]);
    Bottle.find.mockReturnValue(chainLean([{ _id: B1, cellar: CELLAR_A, wineDefinition: null }]));
    const out = await runQuery(USER, { columns: ['wine.producer', 'purchase.price'] });
    expect(out.rows[0].values).toEqual({ 'wine.producer': null, 'purchase.price': null });
  });
});
