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
 * Two kinds of search:
 *  - scoped (`wineIds`): cellar chat, restock, MCP "mine" — reads just those
 *    wines' rows (a very big cellar: a few thousand rows, a few MB);
 *  - registry-wide: MCP "find similar" / "semantic search", restock
 *    suggestions — scans an in-memory copy of every row. The copy is built on
 *    first use, rebuilt when the rows change (their count or newest
 *    embeddedAt, both read from an index, so any process's writes count),
 *    and dropped after 15 idle minutes. ~28 MB for today's 14k rows.
 */

const WineEmbedding = require('../models/WineEmbedding');

const IDLE_MS = 15 * 60 * 1000;

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

// ── Tables: rows packed for scanning ───────────────────────────────────────

const ROW_FIELDS = 'wineDefinition vintage norm dim +vector';

function rowFilter({ model, indexVersion, dim }) {
  return { model, indexVersion, dim };
}

// Packs lean rows (all of dimension `dim`) into one Int8Array.
function pack(rows, dim) {
  const kept = rows.filter((r) => r.dim === dim && r.norm > 0);
  const data = new Int8Array(kept.length * dim);
  const norms = new Float32Array(kept.length);
  const wine = new Array(kept.length);
  const vintage = new Array(kept.length);
  kept.forEach((r, i) => {
    const v = int8Of(r.vector);
    if (v && v.length === dim) data.set(v, i * dim);
    norms[i] = r.norm;
    wine[i] = String(r.wineDefinition);
    vintage[i] = r.vintage;
  });
  return { dim, n: kept.length, data, norms, wine, vintage };
}

async function scopedTable({ model, indexVersion, dim, wineIds }) {
  if (!wineIds.length) return pack([], dim);
  const rows = await WineEmbedding.find({ ...rowFilter({ model, indexVersion, dim }), wineDefinition: { $in: wineIds } })
    .select(ROW_FIELDS)
    .lean();
  return pack(rows, dim);
}

// The registry-wide copy: one per (model, index version, dimension).
let registry = null;   // { key, signature, table, bytes, builtAt }
let building = null;   // { key, promise }
let idleTimer = null;

async function signatureOf(filter) {
  const [count, newest] = await Promise.all([
    WineEmbedding.countDocuments(filter),
    WineEmbedding.findOne(filter).sort({ embeddedAt: -1 }).select('embeddedAt').lean(),
  ]);
  return `${count}:${newest && newest.embeddedAt ? new Date(newest.embeddedAt).getTime() : 0}`;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { registry = null; idleTimer = null; }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function registryTable({ model, indexVersion, dim }) {
  const filter = rowFilter({ model, indexVersion, dim });
  const key = `${model}|${indexVersion}|${dim}`;
  const signature = await signatureOf(filter);
  if (registry && registry.key === key && registry.signature === signature) {
    touch();
    return registry.table;
  }
  if (building && building.key === key && building.signature === signature) return building.promise;
  const promise = (async () => {
    const rows = await WineEmbedding.find(filter).select(ROW_FIELDS).lean();
    const table = pack(rows, dim);
    registry = { key, signature, table, bytes: table.data.byteLength, builtAt: new Date() };
    touch();
    return table;
  })();
  building = { key, signature, promise };
  try {
    return await promise;
  } finally {
    if (building && building.promise === promise) building = null;
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
  const query = unit(queryValues);
  const dim = query.length;
  const table = Array.isArray(wineIds)
    ? await scopedTable({ model, indexVersion, dim, wineIds })
    : await registryTable({ model, indexVersion, dim });

  const exclude = excludeWineId ? String(excludeWineId) : null;
  const scores = new Float32Array(table.n);
  for (let r = 0; r < table.n; r++) {
    const off = r * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += table.data[off + d] * query[d];
    scores[r] = s / table.norms[r];
  }

  let candidates;
  if (distinctWines) {
    const best = new Map(); // wine -> row
    for (let r = 0; r < table.n; r++) {
      const w = table.wine[r];
      const cur = best.get(w);
      if (cur === undefined || scores[r] > scores[cur]) best.set(w, r);
    }
    candidates = [...best.values()];
  } else {
    candidates = Array.from({ length: table.n }, (_, r) => r);
  }
  candidates = candidates.filter((r) => scores[r] >= minScore && table.wine[r] !== exclude);
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

module.exports = { encodeVector, search, getVector, stats, forget, _internal: { int8Of, unit, pack } };
