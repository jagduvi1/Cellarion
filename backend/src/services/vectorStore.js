/**
 * Wine vectors, kept in MongoDB and compared in memory.
 *
 * Until 2026-09 the vectors lived in a Qdrant container. At Cellarion's size
 * a vector database bought nothing a plain scan doesn't: a few thousand
 * vectors per cellar, ~14k for the whole registry, a few registry-wide
 * searches a day. Comparing every vector takes ~16 ms per 11k on one core.
 * A vector index only pays off at hundreds of thousands of vectors, or many
 * searches a second. So each WineEmbedding row (one per wine × vintage ×
 * model × index version) now carries its own vector, and searches happen
 * here.
 *
 * Storage: int8, at the provider's full dimension (2048 for Voyage), each
 * value divided by the vector's largest |value| and scaled to ±127. A 2048
 * vector is 2 KB. Cosine ignores scale, so the row also keeps the int8
 * vector's length (`norm`) to finish the cosine at search time. On
 * production's 14,106 vectors this agreed with Qdrant's own search on 99.6%
 * of "similar wines" and 97% of free-text top-10 results. Cutting to 1024
 * dimensions agreed on only 72% of free-text results, so the full dimension
 * stays.
 *
 * Every search scans ONE in-memory copy of all rows — registry-wide (MCP
 * "find similar" / "semantic search", restock suggestions) or scoped to some
 * wines (`wineIds`: cellar chat, restock, MCP "mine"), which only scores the
 * rows of those wines. One shared copy, not a read per search: a bulk "mark
 * as drunk" of 60 wines once read a big cellar's vectors 60 times at once
 * and ran the process out of memory (review 2026-09-27).
 *
 * The copy (~28 MB for today's 14k rows) is built on first use by streaming
 * the rows, one build at a time. It is checked against the rows at most
 * every FRESH_MS — their count and newest embeddedAt, read from an index, so
 * any process's writes count — and rebuilt when they changed: a search may
 * miss a vector written in the last half minute, and a busy embedding job
 * can't trigger a rebuild per search. Dropped after 15 idle minutes.
 */

const WineEmbedding = require('../models/WineEmbedding');

const IDLE_MS = 15 * 60 * 1000;
const FRESH_MS = 30 * 1000;

// ── Encoding ────────────────────────────────────────────────────────────────

/**
 * A float vector as stored: { vector: Buffer (int8), norm, dim }.
 * @param {ArrayLike<number>} values
 */
function encodeVector(values) {
  const dim = values.length;
  let max = 0;
  for (let i = 0; i < dim; i++) {
    const a = Math.abs(values[i]);
    if (a > max) max = a;
  }
  const out = Buffer.alloc(dim);
  const q = new Int8Array(out.buffer, out.byteOffset, dim);
  let sq = 0;
  for (let i = 0; i < dim; i++) {
    const v = max > 0 ? Math.round((values[i] / max) * 127) : 0;
    q[i] = v;
    sq += v * v;
  }
  return { vector: out, norm: Math.sqrt(sq), dim };
}

// The stored bytes as int8, whether the driver handed back a Buffer or a
// bson Binary (lean reads).
function int8Of(stored) {
  if (!stored) return null;
  let bytes = null;
  if (stored instanceof Uint8Array) bytes = stored;
  else if (stored.buffer instanceof Uint8Array) {
    bytes = typeof stored.position === 'number' ? stored.buffer.subarray(0, stored.position) : stored.buffer;
  }
  return bytes ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}

// A query as a unit-length Float32Array.
function unit(values) {
  let sq = 0;
  for (let i = 0; i < values.length; i++) sq += values[i] * values[i];
  const n = Math.sqrt(sq) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] / n;
  return out;
}

// ── The in-memory copy ─────────────────────────────────────────────────────

const ROW_FIELDS = 'wineDefinition vintage norm dim +vector';

// One copy per (model, index version, dimension) — in practice one.
let registry = null;   // { key, signature, table, bytes, builtAt, checkedAt }
let building = null;   // the build in progress (one at a time)
let idleTimer = null;

async function signatureOf(filter) {
  const [count, newest] = await Promise.all([
    WineEmbedding.countDocuments(filter),
    WineEmbedding.findOne(filter).sort({ embeddedAt: -1 }).select('embeddedAt').lean(),
  ]);
  return { count, key: `${count}:${newest && newest.embeddedAt ? new Date(newest.embeddedAt).getTime() : 0}` };
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { registry = null; idleTimer = null; }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// Streams the rows straight into one packed Int8Array: the peak is the copy
// itself plus one cursor batch, not every row decoded at once.
async function build(filter, key, signature) {
  const { dim } = filter;
  let cap = signature.count + 64;
  let data = new Int8Array(cap * dim);
  let norms = new Float32Array(cap);
  const wine = [];
  const vintage = [];
  let n = 0;
  const cursor = WineEmbedding.find(filter).select(ROW_FIELDS).lean().cursor({ batchSize: 500 });
  for await (const r of cursor) {
    const v = int8Of(r.vector);
    if (!v || v.length !== dim || !(r.norm > 0)) continue;
    if (n === cap) { // rows written since the count: grow
      cap = Math.ceil(cap * 1.25) + 64;
      const d2 = new Int8Array(cap * dim); d2.set(data); data = d2;
      const n2 = new Float32Array(cap); n2.set(norms); norms = n2;
    }
    data.set(v, n * dim);
    norms[n] = r.norm;
    wine[n] = String(r.wineDefinition);
    vintage[n] = r.vintage;
    n += 1;
  }
  const table = { dim, n, data, norms, wine, vintage };
  const now = Date.now();
  registry = { key, signature: signature.key, table, bytes: n * dim, builtAt: new Date(now), checkedAt: now };
  touch();
}

async function registryTable({ model, indexVersion, dim }) {
  const filter = { model, indexVersion, dim };
  const key = `${model}|${indexVersion}|${dim}`;
  for (;;) {
    if (registry && registry.key === key && Date.now() - registry.checkedAt < FRESH_MS) {
      touch();
      return registry.table;
    }
    if (building) { // one build at a time — wait for it, then look again
      await building.catch(() => {});
      continue;
    }
    const signature = await signatureOf(filter);
    if (registry && registry.key === key && registry.signature === signature.key) {
      registry.checkedAt = Date.now();
      touch();
      return registry.table;
    }
    if (building) continue; // another search started one meanwhile
    building = build(filter, key, signature);
    try {
      await building;
    } finally {
      building = null;
    }
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * The closest stored vectors to a query.
 *
 * @param {ArrayLike<number>} queryValues – float vector (any scale)
 * @param {object}  opts
 * @param {string}  opts.model            – embedding model the rows must come from
 * @param {string}  opts.indexVersion     – bookkeeping index version (aiConfig.vectorIndex)
 * @param {Array}   [opts.wineIds]        – only these wines (a scoped search); omitted = the registry
 * @param {number}  [opts.limit=10]
 * @param {string}  [opts.excludeWineId]  – leave this wine out (the reference of "similar")
 * @param {boolean} [opts.distinctWines]  – one hit per wine (its best-scoring vintage)
 * @param {number}  [opts.minScore]       – drop hits below this cosine
 * @returns {Promise<Array<{ wineDefinitionId: string, vintage: string, score: number }>>}
 */
async function search(queryValues, {
  model, indexVersion, wineIds = null, limit = 10, excludeWineId = null, distinctWines = false, minScore = -Infinity,
} = {}) {
  if (!queryValues || !queryValues.length) return [];
  if (Array.isArray(wineIds) && wineIds.length === 0) return [];
  const query = unit(queryValues);
  const dim = query.length;
  const table = await registryTable({ model, indexVersion, dim });
  const only = Array.isArray(wineIds) ? new Set(wineIds.map(String)) : null;
  const exclude = excludeWineId ? String(excludeWineId) : null;

  // Score only the rows in scope.
  const scores = new Float32Array(table.n);
  let candidates = [];
  for (let r = 0; r < table.n; r++) {
    const w = table.wine[r];
    if ((only && !only.has(w)) || w === exclude) continue;
    const off = r * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += table.data[off + d] * query[d];
    const score = s / table.norms[r];
    if (score < minScore) continue;
    scores[r] = score;
    candidates.push(r);
  }
  if (distinctWines) {
    const best = new Map(); // wine -> row
    for (const r of candidates) {
      const cur = best.get(table.wine[r]);
      if (cur === undefined || scores[r] > scores[cur]) best.set(table.wine[r], r);
    }
    candidates = [...best.values()];
  }
  candidates.sort((a, b) => scores[b] - scores[a]);
  return candidates.slice(0, Math.max(0, limit)).map((r) => ({
    wineDefinitionId: table.wine[r],
    vintage: table.vintage[r],
    score: scores[r],
  }));
}

/**
 * A wine's stored vector as floats, for use as a query ("similar to this").
 * Prefers the given vintage, else the newest vintage with a vector.
 * @returns {Promise<Float32Array|null>}
 */
async function getVector(wineDefinitionId, vintage, { model, indexVersion }) {
  const filter = { wineDefinition: wineDefinitionId, model, indexVersion, dim: { $gt: 0 } };
  let row = vintage
    ? await WineEmbedding.findOne({ ...filter, vintage }).select('dim +vector').lean()
    : null;
  if (!row) row = await WineEmbedding.findOne(filter).sort({ vintage: -1 }).select('dim +vector').lean();
  const v = row && int8Of(row.vector);
  return v ? Float32Array.from(v) : null;
}

/** What the admin page shows about the stored vectors and the in-memory copy. */
async function stats({ model, indexVersion }) {
  const byDim = await WineEmbedding.aggregate([
    { $match: { model, indexVersion, dim: { $gt: 0 } } },
    { $group: { _id: '$dim', rows: { $sum: 1 } } },
  ]);
  const rows = byDim.reduce((s, d) => s + d.rows, 0);
  return {
    rows,
    dims: byDim.map((d) => d._id),
    bytes: byDim.reduce((s, d) => s + d.rows * d._id, 0),
    memory: registry
      ? { rows: registry.table.n, bytes: registry.bytes, builtAt: registry.builtAt }
      : null,
  };
}

/** Drop the in-memory copy (tests; memory). */
function forget() {
  registry = null;
  building = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

module.exports = { encodeVector, search, getVector, stats, forget, _internal: { int8Of, unit, FRESH_MS } };
