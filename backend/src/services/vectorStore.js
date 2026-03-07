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

const { VOYAGE_DIMENSION } = require('./embedding');

function qdrantBase() {
  return (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
}

function collectionName(indexVersion) {
  return `wines_${indexVersion}`;
}

async function qdrantRequest(method, path, body) {
  const url = `${qdrantBase()}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
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
    await qdrantRequest('GET', `/collections/${name}`);
    return; // already exists
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Create it
  await qdrantRequest('PUT', `/collections/${name}`, {
    vectors: {
      size: VOYAGE_DIMENSION,
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
 * @returns {Promise<Array<{ id: string, score: number, payload: object }>>}
 */
async function searchSimilar(indexVersion, vector, topK = 50) {
  const name = collectionName(indexVersion);
  const result = await qdrantRequest('POST', `/collections/${name}/points/search`, {
    vector,
    limit: topK,
    with_payload: true
  });
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

module.exports = {
  ensureCollection,
  upsertPoints,
  searchSimilar,
  deletePoints,
  dropCollection,
  collectionInfo,
  collectionName
};
