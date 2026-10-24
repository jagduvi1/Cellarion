/**
 * R-B key/value joins resolve the SAME value per bottle that the displayed
 * column shows: a registry key reads the bottle's vintage override, else the
 * wine-wide default (registryDataOps.resolveForVintage); a personal key reads
 * bottle entry > wine entry of the bottle's vintage > wine entry for every
 * vintage. Rows written before the `vintage` field existed carry no field at
 * all and count as the every-vintage slot.
 *
 * Two layers: the generated $lookup shape is pinned, and the generated
 * sub-pipeline is run through a small evaluator (missing ≠ null, as in
 * MongoDB's aggregation comparisons) next to the hydrated column, so sort,
 * group and sum can never disagree with what the row displays.
 */

jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), find: jest.fn() }));
jest.mock('../../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../../models/Rack', () => ({ find: jest.fn() }));
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
  resolveEffectiveWindow: jest.fn(() => null),
}));

const mongoose = require('mongoose');
const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const PersonalDataKey = require('../../models/PersonalDataKey');
const RegistryDataKey = require('../../models/RegistryDataKey');
const { runQuery } = require('./queryEngine');

const USER = 'a'.repeat(24);
const CELLAR = 'b'.repeat(24);
const KEY_ID = 'd'.repeat(24);
const WINE = new mongoose.Types.ObjectId('e'.repeat(24));
const BOTTLE = new mongoose.Types.ObjectId('f'.repeat(24));
const OTHER_BOTTLE = new mongoose.Types.ObjectId('9'.repeat(24));
const KEY = new mongoose.Types.ObjectId(KEY_ID);
const AUTHOR = new mongoose.Types.ObjectId(USER);

const chainLean = (docs) => {
  const c = {};
  for (const m of ['select', 'limit', 'sort', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => docs);
  return c;
};
const aggReturning = (result) => {
  const captured = { pipelines: [] };
  Bottle.aggregate.mockImplementation((pipeline) => {
    captured.pipelines.push(pipeline);
    return { option: jest.fn(async () => result) };
  });
  return captured;
};

const SLOT = { $ifNull: ['$vintage', null] };

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue(chainLean([{ _id: CELLAR, name: 'Home' }]));
});

function registryKey(doc) {
  RegistryDataKey.findOne.mockReturnValue({ lean: async () => ({ _id: KEY_ID, status: 'accepted', ...doc }) });
}
function personalKey(doc) {
  PersonalDataKey.findOne.mockReturnValue({ lean: async () => ({ _id: KEY_ID, user: USER, ...doc }) });
}
const lookupFrom = (pipeline, from) => pipeline.find((s) => s.$lookup && s.$lookup.from === from)?.$lookup;

// ── a minimal evaluator for the sub-pipeline subset the joins emit ─────────

const norm = (v) => (v instanceof mongoose.Types.ObjectId ? v.toHexString() : v);
// MongoDB aggregation comparisons: a missing field is NOT equal to null.
const same = (x, y) => norm(x) === norm(y);

function ev(expr, doc, vars) {
  if (Array.isArray(expr)) return expr.map((e) => ev(e, doc, vars));
  if (typeof expr === 'string') {
    if (expr.startsWith('$$')) return vars[expr.slice(2)];
    if (expr.startsWith('$')) return expr.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
    return expr;
  }
  if (expr === null || typeof expr !== 'object' || expr instanceof mongoose.Types.ObjectId) return expr;
  const [op] = Object.keys(expr);
  const a = expr[op];
  switch (op) {
    case '$and': return a.every((e) => ev(e, doc, vars));
    case '$or': return a.some((e) => ev(e, doc, vars));
    case '$eq': return same(ev(a[0], doc, vars), ev(a[1], doc, vars));
    case '$ne': return !same(ev(a[0], doc, vars), ev(a[1], doc, vars));
    case '$in': {
      const v = ev(a[0], doc, vars);
      return ev(a[1], doc, vars).some((x) => same(v, x));
    }
    case '$ifNull': {
      const v = ev(a[0], doc, vars);
      return v === undefined || v === null ? ev(a[1], doc, vars) : v;
    }
    case '$cond': return ev(a[0], doc, vars) ? ev(a[1], doc, vars) : ev(a[2], doc, vars);
    case '$switch': {
      for (const b of a.branches) if (ev(b.case, doc, vars)) return ev(b.then, doc, vars);
      return ev(a.default, doc, vars);
    }
    default: throw new Error(`evaluator: unsupported operator ${op}`);
  }
}

/** Run one $lookup's let + sub-pipeline for one bottle over in-memory rows. */
function joinedValue(lookup, bottle, rows) {
  const vars = {};
  for (const [k, e] of Object.entries(lookup.let)) vars[k] = ev(e, bottle, {});
  let docs = rows.map((r) => ({ ...r }));
  for (const st of lookup.pipeline) {
    if (st.$match) docs = docs.filter((d) => ev(st.$match.$expr, d, vars));
    else if (st.$addFields) {
      docs = docs.map((d) => {
        const o = { ...d };
        for (const [k, e] of Object.entries(st.$addFields)) o[k] = ev(e, d, vars);
        return o;
      });
    } else if (st.$sort) {
      const [[k, dir]] = Object.entries(st.$sort);
      docs = [...docs].sort((x, y) => (x[k] - y[k]) * dir);
    } else if (st.$limit) docs = docs.slice(0, st.$limit);
    else if (st.$project) docs = docs.map((d) => ({ value: d.value }));
    else throw new Error(`evaluator: unsupported stage ${Object.keys(st)[0]}`);
  }
  return docs.length ? docs[0].value : null;
}

/**
 * One rows query that sorts on the key AND displays it: returns the value the
 * sort join resolves for the bottle and the value its column shows.
 */
async function sortedVersusShown(source, bottle, rows) {
  const field = `${source}.${KEY_ID}`;
  const cap = aggReturning([{ ids: [{ _id: bottle._id }], total: [{ n: 1 }] }]);
  Bottle.find.mockReturnValue(chainLean([bottle]));
  if (source === 'registry') RegistryDataValue.find.mockReturnValue(chainLean(rows));
  else PersonalDataEntry.find.mockReturnValue(chainLean(rows));
  const out = await runQuery(USER, { sort: { field, dir: 'asc' }, columns: [field] });
  const lookup = lookupFrom(cap.pipelines[0], source === 'registry' ? 'registrydatavalues' : 'personaldataentries');
  return { sorted: joinedValue(lookup, bottle, rows), shown: out.rows[0].values[field] };
}

// ── registry keys ───────────────────────────────────────────────────────────

describe('registry key join respects the vintage', () => {
  beforeEach(() => registryKey({ name: 'ABV', type: 'decimal', unit: '%' }));

  const bottle = (vintage) => ({ _id: BOTTLE, wineDefinition: WINE, vintage });
  const row = (vintage, value) => ({
    wineDefinition: WINE, key: KEY, status: 'published', value, ...(vintage === undefined ? {} : { vintage }),
  });

  test('the sub-pipeline matches the default slot or the exact vintage, exact first, then $limit 1', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, { sort: { field: `registry.${KEY_ID}`, dir: 'desc' } });
    const lookup = lookupFrom(cap.pipelines[0], 'registrydatavalues');
    expect(lookup.let).toEqual({ wid: '$wineDefinition', vint: '$vintage' });
    const inner = lookup.pipeline;
    expect(inner[0].$match.$expr.$and).toContainEqual({ $in: [SLOT, [null, '$$vint']] });
    expect(inner[1]).toEqual({ $addFields: { _prio: { $cond: [{ $eq: [SLOT, null] }, 1, 0] } } });
    expect(inner[2]).toEqual({ $sort: { _prio: 1 } });
    expect(inner[3]).toEqual({ $limit: 1 });
  });

  test("another vintage's override never stands in for this bottle's value", async () => {
    const r = await sortedVersusShown('registry', bottle('2019'), [row('2018', 13), row(null, 12.5)]);
    expect(r).toEqual({ sorted: 12.5, shown: 12.5 });
  });

  test("the bottle's own vintage override beats the wine-wide default", async () => {
    const r = await sortedVersusShown('registry', bottle('2019'), [row(null, 12.5), row('2019', 14)]);
    expect(r).toEqual({ sorted: 14, shown: 14 });
  });

  test('a wine whose only published row is another vintage reads blank', async () => {
    const r = await sortedVersusShown('registry', bottle('2019'), [row('2018', 13)]);
    expect(r).toEqual({ sorted: null, shown: null });
  });

  test('a row written before the vintage field existed is the default slot', async () => {
    const r = await sortedVersusShown('registry', bottle('2019'), [row('2018', 13), row(undefined, 12)]);
    expect(r).toEqual({ sorted: 12, shown: 12 });
  });

  test('a non-vintage bottle reads the default', async () => {
    const r = await sortedVersusShown('registry', bottle('NV'), [row('2018', 13), row(null, 12.5)]);
    expect(r).toEqual({ sorted: 12.5, shown: 12.5 });
  });

  test('grouped mode: an enum registry dimension uses the same vintage-aware join', async () => {
    registryKey({ name: 'Closure', type: 'enum', enumOptions: ['cork', 'screwcap'] });
    const cap = aggReturning([{ _id: { d0: 'cork' }, m0: 3 }]);
    await runQuery(USER, {
      mode: 'grouped', dimensions: [`registry.${KEY_ID}`], measures: [{ field: '*', agg: 'count' }],
    });
    const p = cap.pipelines[0];
    const lookup = lookupFrom(p, 'registrydatavalues');
    expect(lookup.as).toBe('_d0v_j');
    expect(lookup.let.vint).toBe('$vintage');
    expect(lookup.pipeline[0].$match.$expr.$and).toContainEqual({ $in: [SLOT, [null, '$$vint']] });
    expect(lookup.pipeline.find((s) => s.$sort)).toEqual({ $sort: { _prio: 1 } });
    expect(p.find((s) => s.$group).$group._id).toEqual({ d0: '$_d0v' });
    // Bucketing reads the vintage's value, not whichever row comes first.
    const b = { _id: BOTTLE, wineDefinition: WINE, vintage: '2019' };
    expect(joinedValue(lookup, b, [row('2018', 'screwcap'), row(null, 'cork')])).toBe('cork');
  });

  test('grouped mode: a numeric registry measure sums the vintage-resolved value', async () => {
    const cap = aggReturning([{ _id: { d0: 'red' }, m0: 13 }]);
    await runQuery(USER, {
      mode: 'grouped', dimensions: ['wine.type'], measures: [{ field: `registry.${KEY_ID}`, agg: 'avg' }],
    });
    const lookup = lookupFrom(cap.pipelines[0], 'registrydatavalues');
    expect(lookup.as).toBe('_m0v_j');
    const b = { _id: BOTTLE, wineDefinition: WINE, vintage: '2019' };
    expect(joinedValue(lookup, b, [row(null, 12.5), row('2019', 14), row('2020', 15)])).toBe(14);
  });
});

// ── personal keys ───────────────────────────────────────────────────────────

describe('personal key join reads a missing vintage as every-vintage', () => {
  beforeEach(() => personalKey({ name: 'ABV', type: 'decimal', unit: '%' }));

  const bottle = { _id: BOTTLE, wineDefinition: WINE, vintage: '2019' };
  const wineEntry = (vintage, value) => ({
    author: AUTHOR, key: KEY, targetType: 'wine', wineDefinition: WINE, value,
    ...(vintage === undefined ? {} : { vintage }),
  });
  const bottleEntry = (b, value) => ({ author: AUTHOR, key: KEY, targetType: 'bottle', bottle: b, vintage: null, value });

  test('the match and the _prio switch both read $vintage through $ifNull', async () => {
    const cap = aggReturning([{ ids: [], total: [] }]);
    await runQuery(USER, { sort: { field: `personal.${KEY_ID}`, dir: 'asc' } });
    const inner = lookupFrom(cap.pipelines[0], 'personaldataentries').pipeline;
    const wineArm = inner[0].$match.$expr.$and[2].$or[1].$and;
    expect(wineArm).toContainEqual({ $in: [SLOT, [null, '$$vint']] });
    const prio = inner.find((s) => s.$addFields && s.$addFields._prio).$addFields._prio.$switch;
    expect(prio.branches[1]).toEqual({ case: { $ne: [SLOT, null] }, then: 1 });
    expect(prio.default).toBe(2);
  });

  test('a wine entry written without a vintage field counts, as the column shows it', async () => {
    const r = await sortedVersusShown('personal', bottle, [wineEntry(undefined, 12)]);
    expect(r).toEqual({ sorted: 12, shown: 12 });
  });

  test("an entry for the bottle's vintage still beats one without a vintage field", async () => {
    const r = await sortedVersusShown('personal', bottle, [wineEntry(undefined, 12), wineEntry('2019', 14)]);
    expect(r).toEqual({ sorted: 14, shown: 14 });
  });

  test('a bottle entry beats both wine levels', async () => {
    const r = await sortedVersusShown('personal', bottle,
      [wineEntry(undefined, 12), wineEntry('2019', 14), bottleEntry(BOTTLE, 15)]);
    expect(r).toEqual({ sorted: 15, shown: 15 });
  });

  test("another vintage's entry and another bottle's entry do not apply", async () => {
    const r = await sortedVersusShown('personal', bottle, [wineEntry('2018', 13), bottleEntry(OTHER_BOTTLE, 11)]);
    expect(r).toEqual({ sorted: null, shown: null });
  });
});
