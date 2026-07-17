/**
 * Qdrant vector-store client.
 *
 * Wraps the Qdrant REST API using Node's built-in fetch. No SDK dependency —
 * the relevant endpoints are straightforward enough to call directly.
 *
 * Collection naming: wines_<indexVersion>  (e.g. wines_v1)
 *
 * Point payload stored alongside each vector:
 *   { wineDefinitionId, vintage, name, producer, type }
 *
 * This module is the only place in the codebase that talks to Qdrant, which
 * makes index migrations (v1 → v2) easy to reason about.
 */

const { getEmbeddingDimension } = require('./embedding');

// Outbound timeout: Node fetch has no application-level timeout, so a stalled
// Qdrant connection would park callers (notably the /api/chat RAG path) until
// undici's ~300 s default fires. Same AbortSignal pattern as imageProcessor.js.
const QDRANT_TIMEOUT_MS = 8000;

function qdrantBase() {
  return (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
}

function collectionName(indexVersion) {
  return `wines_${indexVersion}`;
}

async function qdrantRequest(method, path, body) {
  const url = `${qdrantBase()}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  // Optional Qdrant API key (security audit L-5). Qdrant is internal-only and
  // not host-published, so this defaults off; a self-hoster who sets
  // QDRANT_API_KEY (and QDRANT__SERVICE__API_KEY on the qdrant container) gets
  // authenticated access, closing same-network container access.
  if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
  const opts = {
    method,
    headers,
    signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS)
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    // Surface timeouts as the same plain-Error shape callers already handle
    // for Qdrant connection failures (no .status → generic degrade path).
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Qdrant ${method} ${path} timed out after ${QDRANT_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw Object.assign(
      new Error(`Qdrant ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`),
      { status: res.status }
    );
  }
  return json;
}

/**
 * Create the collection if it doesn't already exist.
 * Safe to call multiple times — idempotent.
 */
async function ensureCollection(indexVersion) {
  const name = collectionName(indexVersion);

  // Check if collection exists
  try {
    const info = await qdrantRequest('GET', `/collections/${name}`);
    // A collection built for a different embedding dimension (provider/model
    // switch without the required FULL re-embed) makes every upsert/search
    // fail with an opaque Qdrant 400 — call it out loudly and point at the
    // fix. Not thrown: the full embedding job runs through here right before
    // it drops + recreates the collection, which IS the fix.
    const existingSize = info.result?.config?.params?.vectors?.size;
    const wantedSize = getEmbeddingDimension();
    if (existingSize && existingSize !== wantedSize) {
      console.error(
        `[vectorStore] Collection ${name} holds ${existingSize}-dim vectors but the active embedding provider produces ${wantedSize}-dim — ` +
        `vector search will fail until a FULL embedding job rebuilds the collection (SuperAdmin → AI)`
      );
    }
    return; // already exists
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Create it, sized to the active embedding provider's vector dimension.
  // Changing provider/model/dimension requires a FULL embedding job (drops +
  // recreates the collection at the new size).
  const size = getEmbeddingDimension();
  if (!(size > 0)) {
    // Refuse rather than create a broken collection — this matters most in
    // the full-job path, which has already DROPPED the old collection when
    // it calls back in here.
    throw new Error('Embedding dimension is not configured (EMBEDDING_DIMENSION) — refusing to create the vector collection');
  }
  await qdrantRequest('PUT', `/collections/${name}`, {
    vectors: {
      size,
      distance: 'Cosine'
    }
  });

  console.log(`[vectorStore] Created Qdrant collection: ${name}`);
}

/**
 * Upsert points into the collection. Each point: { id, vector, payload }.
 *
 * @param {string} indexVersion
 * @param {Array<{ id: string, vector: number[], payload: object }>} points
 */
async function upsertPoints(indexVersion, points) {
  if (!points.length) return;
  const name = collectionName(indexVersion);
  await qdrantRequest('PUT', `/collections/${name}/points`, {
    points
  });
}

/**
 * Vector similarity search.
 *
 * @param {string}   indexVersion
 * @param {number[]} vector – query vector
 * @param {number}   topK   – number of results
 * @param {object}   [options]
 * @param {object}   [options.filter] – optional Qdrant payload filter (e.g.
 *   { must: [{ key: 'wineDefinitionId', match: { any: ['…','…'] } }] })
 * @returns {Promise<Array<{ id: string, score: number, payload: object }>>}
 */
async function searchSimilar(indexVersion, vector, topK = 50, { filter } = {}) {
  const name = collectionName(indexVersion);
  const body = {
    vector,
    limit: topK,
    with_payload: true
  };
  if (filter) body.filter = filter;
  const result = await qdrantRequest('POST', `/collections/${name}/points/search`, body);
  return (result.result || []).map(hit => ({
    id: hit.id,
    score: hit.score,
    payload: hit.payload || {}
  }));
}

/**
 * Delete points by their Qdrant IDs (UUIDs).
 *
 * @param {string}   indexVersion
 * @param {string[]} ids
 */
async function deletePoints(indexVersion, ids) {
  if (!ids.length) return;
  const name = collectionName(indexVersion);
  await qdrantRequest('POST', `/collections/${name}/points/delete`, {
    points: ids
  });
}

/**
 * Delete an entire collection (used when wiping and rebuilding an index version).
 *
 * @param {string} indexVersion
 */
async function dropCollection(indexVersion) {
  const name = collectionName(indexVersion);
  try {
    await qdrantRequest('DELETE', `/collections/${name}`);
    console.log(`[vectorStore] Dropped Qdrant collection: ${name}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

/**
 * The vector size an existing collection was created with, or null when the
 * collection doesn't exist. Used to fail an incremental embedding job fast
 * when the active provider's dimension doesn't match.
 */
async function collectionVectorSize(indexVersion) {
  const name = collectionName(indexVersion);
  try {
    const res = await qdrantRequest('GET', `/collections/${name}`);
    return res.result?.config?.params?.vectors?.size ?? null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Return basic stats about a collection (count of vectors).
 */
async function collectionInfo(indexVersion) {
  const name = collectionName(indexVersion);
  try {
    const res = await qdrantRequest('GET', `/collections/${name}`);
    return {
      exists: true,
      vectorCount: res.result?.vectors_count ?? 0,
      name
    };
  } catch (err) {
    if (err.status === 404) return { exists: false, vectorCount: 0, name };
    throw err;
  }
}

/**
 * Retrieve points by IDs, including their vectors.
 * Returns array of { id, vector, payload }.
 */
async function getPoints(indexVersion, ids) {
  const name = collectionName(indexVersion);
  const res = await qdrantRequest('POST', `/collections/${name}/points`, {
    ids,
    with_vector: true,
    with_payload: true
  });
  return res.result || [];
}

module.exports = {
  ensureCollection,
  upsertPoints,
  searchSimilar,
  getPoints,
  deletePoints,
  dropCollection,
  collectionInfo,
  collectionVectorSize,
  collectionName
};
