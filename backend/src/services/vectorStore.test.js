/**
 * Vector search without a vector database (2026-09): the vectors live on the
 * WineEmbedding rows as int8 and are compared in memory.
 *
 * WHY THIS TEST EXISTS:
 * Qdrant was retired; this module now answers the cellar chat, restock
 * alerts and the MCP similarity tools. Pinned here: the int8 encoding keeps
 * the cosine (on production data it agreed with Qdrant on 97–99.6% of top-10
 * results), scoped and registry-wide searches rank, collapse to one hit per
 * wine, exclude and threshold correctly, and the registry-wide copy is built
 * once and rebuilt only when the rows change.
 */
jest.mock('../models/WineEmbedding', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));

const WineEmbedding = require('../models/WineEmbedding');
const vectorStore = require('./vectorStore');

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
function install() {
  const matches = (q, r) => (q.dim === undefined || (typeof q.dim === 'number' ? r.dim === q.dim : r.dim > 0))
    && (!q.wineDefinition || (q.wineDefinition.$in ? q.wineDefinition.$in.map(String).includes(String(r.wineDefinition)) : String(q.wineDefinition) === String(r.wineDefinition)))
    && (!q.vintage || r.vintage === q.vintage);
  WineEmbedding.find.mockImplementation((q) => {
    const chain = { select: () => chain, lean: async () => ROWS.filter((r) => matches(q, r)) };
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
  vectorStore.forget();
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
  test('scoped to some wines: ranks by cosine, one hit per vintage row', async () => {
    const hits = await vectorStore.search(near(B, 7, 0.02), { ...scope, wineIds: ['wineA', 'wineB'], limit: 10 });
    expect(hits[0]).toMatchObject({ wineDefinitionId: 'wineB', vintage: '2019' });
    expect(hits[0].score).toBeGreaterThan(0.98);
    expect(hits.map((h) => h.wineDefinitionId)).toEqual(['wineB', 'wineA', 'wineA']);
    // Only the given wines' rows were read, with the model/index/dimension filter.
    expect(WineEmbedding.find.mock.calls[0][0]).toMatchObject({ model: MODEL, indexVersion: INDEX, dim: DIM });
    expect(WineEmbedding.countDocuments).not.toHaveBeenCalled();
  });

  test('distinct wines, a reference left out, a threshold, a limit', async () => {
    const hits = await vectorStore.search(A, { ...scope, distinctWines: true, limit: 10 });
    expect(hits.map((h) => h.wineDefinitionId)).toEqual(['wineA', expect.any(String), expect.any(String)]);
    expect(hits[0].vintage).toBe('2015');
    const others = await vectorStore.search(A, { ...scope, distinctWines: true, excludeWineId: 'wineA', limit: 10 });
    expect(others.map((h) => h.wineDefinitionId)).not.toContain('wineA');
    const close = await vectorStore.search(A, { ...scope, minScore: 0.9 });
    expect(close.map((h) => h.wineDefinitionId)).toEqual(['wineA', 'wineA']);
    const one = await vectorStore.search(A, { ...scope, limit: 1 });
    expect(one).toHaveLength(1);
  });

  test('the registry-wide copy is built once and reused while the rows are unchanged', async () => {
    await vectorStore.search(A, scope);
    await vectorStore.search(B, scope);
    expect(WineEmbedding.find).toHaveBeenCalledTimes(1);
    expect(WineEmbedding.countDocuments).toHaveBeenCalledTimes(2);
    const stats = await (async () => { WineEmbedding.aggregate.mockResolvedValue([{ _id: DIM, rows: 4 }]); return vectorStore.stats(scope); })();
    expect(stats).toMatchObject({ rows: 4, dims: [DIM], bytes: 4 * DIM, memory: { rows: 4, bytes: 4 * DIM } });
  });

  test('a new or re-embedded row rebuilds the copy', async () => {
    await vectorStore.search(A, scope);
    ROWS.push(row('wineD', '2020', vec(4), { embeddedAt: new Date('2026-09-02') }));
    const hits = await vectorStore.search(vec(4), { ...scope, limit: 1 });
    expect(hits[0].wineDefinitionId).toBe('wineD');
    expect(WineEmbedding.find).toHaveBeenCalledTimes(2);
    // Same count, newer embeddedAt (a re-embed) — rebuilt too.
    ROWS[0] = row('wineA', '2015', vec(5), { embeddedAt: new Date('2026-09-03') });
    const again = await vectorStore.search(vec(5), { ...scope, limit: 1 });
    expect(again[0]).toMatchObject({ wineDefinitionId: 'wineA', vintage: '2015' });
    expect(WineEmbedding.find).toHaveBeenCalledTimes(3);
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
