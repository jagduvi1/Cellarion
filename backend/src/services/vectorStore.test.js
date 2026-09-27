/**
 * Vector search without a vector database (2026-09): the vectors live on the
 * WineEmbedding rows as int8 and are compared in memory.
 *
 * WHY THIS TEST EXISTS:
 * Qdrant was retired; this module now answers the cellar chat, restock
 * alerts and the MCP similarity tools. Pinned here: the int8 encoding keeps
 * the cosine (on production data it agreed with Qdrant on 97–99.6% of top-10
 * results); searches rank, scope to some wines, collapse to one hit per
 * wine, exclude and threshold correctly; and every search shares ONE
 * in-memory copy — built once (one build even under concurrent searches),
 * checked against the rows at most every FRESH_MS and rebuilt only when they
 * changed. A per-search read of a big cellar's vectors, run 60 times at once
 * by a bulk "mark as drunk", once ran the process out of memory.
 */
jest.mock('../models/WineEmbedding', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));

const WineEmbedding = require('../models/WineEmbedding');
const vectorStore = require('./vectorStore');

const { FRESH_MS } = vectorStore._internal;
const DIM = 64;
const MODEL = 'voyage-4-large';
const INDEX = 'v1';
const scope = { model: MODEL, indexVersion: INDEX };

// Deterministic pseudo-random vectors.
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; }
const vec = (seed) => { const r = rng(seed); return Array.from({ length: DIM }, r); };
const near = (base, seed, amount) => { const r = rng(seed); return base.map((x) => x + r() * amount); };
const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb); };

function row(wine, vintage, values, { binary = false, embeddedAt = new Date('2026-09-01') } = {}) {
  const { vector, norm, dim } = vectorStore.encodeVector(values);
  // A lean read hands back a bson Binary, not a Buffer.
  const stored = binary ? { buffer: new Uint8Array(vector.buffer, vector.byteOffset, vector.length), position: vector.length, sub_type: 0 } : vector;
  return { wineDefinition: wine, vintage, vector: stored, norm, dim, embeddedAt };
}

let ROWS;
let now;
let builds; // cursor reads = builds of the shared copy
function install() {
  const matches = (q, r) => (q.dim === undefined || (typeof q.dim === 'number' ? r.dim === q.dim : r.dim > 0))
    && (!q.wineDefinition || (q.wineDefinition.$in
      ? q.wineDefinition.$in.map(String).includes(String(r.wineDefinition))
      : String(q.wineDefinition) === String(r.wineDefinition)))
    && (!q.vintage || r.vintage === q.vintage)
    && (!q.embeddedAt || r.embeddedAt > q.embeddedAt.$gt);
  WineEmbedding.find.mockImplementation((q) => {
    const chain = {
      select: () => chain,
      lean: () => {
        const rows = () => ROWS.filter((x) => matches(q, x));
        const read = Promise.resolve().then(rows); // an awaited query (a scoped search's recent rows)
        read.cursor = () => { // a build of the shared copy
          builds += 1;
          return { async* [Symbol.asyncIterator]() { for (const r of rows()) yield r; } };
        };
        return read;
      },
    };
    return chain;
  });
  WineEmbedding.findOne.mockImplementation((q) => {
    let sortSpec = null;
    const chain = {
      select: () => chain,
      sort: (s) => { sortSpec = s; return chain; },
      lean: async () => {
        let rows = ROWS.filter((r) => matches(q, r));
        if (sortSpec && sortSpec.embeddedAt) rows = rows.slice().sort((a, b) => b.embeddedAt - a.embeddedAt);
        if (sortSpec && sortSpec.vintage) rows = rows.slice().sort((a, b) => (a.vintage < b.vintage ? 1 : -1));
        return rows[0] || null;
      },
    };
    return chain;
  });
  WineEmbedding.countDocuments.mockImplementation(async (q) => ROWS.filter((r) => matches(q, r)).length);
}

const A = vec(1); const B = vec(2); const C = vec(3);
beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  vectorStore.forget();
  now = Date.parse('2026-09-27T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  builds = 0;
  ROWS = [
    row('wineA', '2015', A), row('wineA', '2016', near(A, 11, 0.05)),
    row('wineB', '2019', B, { binary: true }),
    row('wineC', 'NV', C),
  ];
  install();
});
afterAll(() => vectorStore.forget());

describe('encodeVector', () => {
  test('int8 at full dimension, and the cosine survives', () => {
    const v = vec(42);
    const { vector, norm, dim } = vectorStore.encodeVector(v);
    expect(dim).toBe(DIM);
    expect(vector.length).toBe(DIM);
    const q = new Int8Array(vector.buffer, vector.byteOffset, DIM);
    expect(Math.max(...q.map(Math.abs))).toBe(127);
    expect(norm).toBeCloseTo(Math.sqrt(q.reduce((s, x) => s + x * x, 0)), 6);
    const other = vec(43);
    const encodedCos = q.reduce((s, x, i) => s + x * other[i], 0) / norm / Math.sqrt(other.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(encodedCos - cos(v, other))).toBeLessThan(0.01);
  });
});

describe('search', () => {
  test('scoped to some wines: ranks by cosine over those wines\' rows only', async () => {
    const hits = await vectorStore.search(near(B, 7, 0.02), { ...scope, wineIds: ['wineA', 'wineB'], limit: 10 });
    expect(hits[0]).toMatchObject({ wineDefinitionId: 'wineB', vintage: '2019' });
    expect(hits[0].score).toBeGreaterThan(0.98);
    expect(hits.map((h) => h.wineDefinitionId)).toEqual(['wineB', 'wineA', 'wineA']);
    // Read once, through the model/index/dimension filter.
    expect(WineEmbedding.find.mock.calls[0][0]).toEqual({ model: MODEL, indexVersion: INDEX, dim: DIM });
  });

  test('distinct wines, a reference left out, a threshold, a limit', async () => {
    const hits = await vectorStore.search(A, { ...scope, distinctWines: true, limit: 10 });
    expect(hits.map((h) => h.wineDefinitionId)).toEqual(['wineA', expect.any(String), expect.any(String)]);
    expect(hits[0].vintage).toBe('2015');
    const others = await vectorStore.search(A, { ...scope, distinctWines: true, excludeWineId: 'wineA', limit: 10 });
    expect(others.map((h) => h.wineDefinitionId)).not.toContain('wineA');
    const close = await vectorStore.search(A, { ...scope, minScore: 0.9 });
    expect(close.map((h) => h.wineDefinitionId)).toEqual(['wineA', 'wineA']);
    expect(await vectorStore.search(A, { ...scope, limit: 1 })).toHaveLength(1);
  });

  test('every search — scoped or not — shares one copy; within FRESH_MS the rows are not even checked', async () => {
    await vectorStore.search(A, scope);
    await vectorStore.search(B, { ...scope, wineIds: ['wineB'] });
    await vectorStore.search(C, { ...scope, wineIds: ['wineC', 'wineA'] });
    expect(builds).toBe(1);
    expect(WineEmbedding.countDocuments).toHaveBeenCalledTimes(1); // the first build only
    WineEmbedding.aggregate.mockResolvedValue([{ _id: DIM, rows: 4 }]);
    const stats = await vectorStore.stats(scope);
    expect(stats).toMatchObject({ rows: 4, dims: [DIM], bytes: 4 * DIM, memory: { rows: 4, bytes: 4 * DIM } });
  });

  test('checked again after FRESH_MS: unchanged rows keep the copy, a new or re-embedded row rebuilds it', async () => {
    await vectorStore.search(A, scope);
    now += FRESH_MS + 1;
    await vectorStore.search(A, scope);
    expect(WineEmbedding.countDocuments).toHaveBeenCalledTimes(2);
    expect(builds).toBe(1); // unchanged — no rebuild

    // A new row is not seen before the next check…
    ROWS.push(row('wineD', '2020', vec(4), { embeddedAt: new Date('2026-09-02') }));
    let hits = await vectorStore.search(vec(4), { ...scope, limit: 1 });
    expect(hits[0].wineDefinitionId).not.toBe('wineD');
    // …and is, after it.
    now += FRESH_MS + 1;
    hits = await vectorStore.search(vec(4), { ...scope, limit: 1 });
    expect(hits[0].wineDefinitionId).toBe('wineD');
    expect(builds).toBe(2);

    // Same count, newer embeddedAt (a re-embed) — rebuilt too.
    ROWS[0] = row('wineA', '2015', vec(5), { embeddedAt: new Date('2026-09-03') });
    now += FRESH_MS + 1;
    const again = await vectorStore.search(vec(5), { ...scope, limit: 1 });
    expect(again[0]).toMatchObject({ wineDefinitionId: 'wineA', vintage: '2015' });
    expect(builds).toBe(3);
  });

  test('concurrent searches share one build', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => vectorStore.search(i % 2 ? A : B, { ...scope, wineIds: i % 3 ? null : ['wineA'] })));
    expect(all.every((h) => h.length > 0)).toBe(true);
    expect(builds).toBe(1);
  });

  // Review 2026-09-27: a wine added a moment ago, missing from the copy for up
  // to FRESH_MS, sent its owner a false "time to restock?".
  test('a scoped search counts the rows of its wines written after the copy at once; a registry-wide one after the next check', async () => {
    await vectorStore.search(A, scope); // the copy is built
    const D = vec(6);
    ROWS.push(row('wineD', '2021', D, { embeddedAt: new Date('2026-09-05') }));
    const scoped = await vectorStore.search(near(D, 3, 0.02), { ...scope, wineIds: ['wineA', 'wineD'], limit: 1, minScore: 0.9 });
    expect(scoped[0]).toMatchObject({ wineDefinitionId: 'wineD', vintage: '2021' });
    // A re-embedded row replaces its stale score (same wine + vintage).
    ROWS[0] = row('wineA', '2015', D, { embeddedAt: new Date('2026-09-06') });
    const replaced = await vectorStore.search(D, { ...scope, wineIds: ['wineA'], limit: 5 });
    expect(replaced.filter((h) => h.vintage === '2015')).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ wineDefinitionId: 'wineA', vintage: '2015' });
    expect(replaced[0].score).toBeGreaterThan(0.99);
    expect(builds).toBe(1); // still the same copy
    // Registry-wide: not before the next check…
    const wide = await vectorStore.search(D, { ...scope, distinctWines: true, limit: 10 });
    expect(wide.map((h) => h.wineDefinitionId)).not.toContain('wineD');
    expect(Math.max(...wide.map((h) => h.score))).toBeLessThan(0.99); // wineA still has its old vector there
    now += FRESH_MS + 1;
    const later = await vectorStore.search(D, { ...scope, distinctWines: true, limit: 2 });
    expect(later.map((h) => h.wineDefinitionId).sort()).toEqual(['wineA', 'wineD']);
  });

  test('rows of another dimension are never compared; an empty scope finds nothing', async () => {
    ROWS.push(row('wineE', '2021', Array.from({ length: DIM * 2 }, rng(9))));
    const hits = await vectorStore.search(A, { ...scope, limit: 10 });
    expect(hits.map((h) => h.wineDefinitionId)).not.toContain('wineE');
    expect(await vectorStore.search(A, { ...scope, wineIds: [] })).toEqual([]);
    expect(await vectorStore.search([], scope)).toEqual([]);
  });
});

describe('getVector', () => {
  test('the given vintage, else the newest vintage; null when the wine has none', async () => {
    const exact = await vectorStore.getVector('wineA', '2016', scope);
    expect(cos(Array.from(exact), near(A, 11, 0.05))).toBeGreaterThan(0.999);
    const fallback = await vectorStore.getVector('wineA', '1999', scope);
    expect(cos(Array.from(fallback), near(A, 11, 0.05))).toBeGreaterThan(0.999); // 2016 is the newest
    const fromBinary = await vectorStore.getVector('wineB', null, scope);
    expect(cos(Array.from(fromBinary), B)).toBeGreaterThan(0.999);
    expect(await vectorStore.getVector('nope', '2015', scope)).toBeNull();
  });
});
