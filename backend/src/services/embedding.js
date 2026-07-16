/**
 * Embedding service — Voyage AI by default, or any OpenAI-compatible
 * /v1/embeddings endpoint for self-hosters (issue #698, phase 2).
 *
 *   EMBEDDING_PROVIDER=voyage (default) — Voyage AI REST API, exactly as
 *     before: voyage-4-large at 2048 dimensions (output_dimension requested
 *     explicitly).
 *   EMBEDDING_PROVIDER=openai — POST {EMBEDDING_BASE_URL}/embeddings with
 *     EMBEDDING_MODEL. Self-hosted embedding models have fixed, per-model
 *     vector sizes, so EMBEDDING_DIMENSION is required and every returned
 *     vector is validated against it (a mismatch would silently corrupt the
 *     Qdrant collection).
 *
 * The active dimension (getEmbeddingDimension) sizes the Qdrant collection in
 * vectorStore.js. Changing provider, model, or dimension therefore requires a
 * FULL embedding job (drops + recreates the collection) — same procedure as a
 * Voyage model upgrade.
 *
 * Env (openai mode)
 * -----------------
 *   EMBEDDING_BASE_URL     – /v1 root; falls back to OPENAI_BASE_URL so an
 *                            Ollama/vLLM install can serve chat + embeddings
 *                            off one URL
 *   EMBEDDING_API_KEY      – optional; falls back to OPENAI_API_KEY
 *   EMBEDDING_MODEL        – required, e.g. nomic-embed-text / bge-m3
 *   EMBEDDING_DIMENSION    – required, the model's vector size (e.g. 768)
 *   EMBEDDING_TIMEOUT_MS   – optional, default 30000
 *
 * Throttle strategy (both providers)
 * ----------------------------------
 * Voyage's free tier allows 3 requests per minute. Any 429 response is
 * retried with truncated exponential backoff + jitter (initial 2 s, doubles
 * each attempt, capped at 64 s). A Retry-After header is honoured when
 * present. Permanent errors (4xx other than 429, 5xx after max retries) are
 * thrown.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_DIMENSION = 2048;
const DEFAULT_MODEL = 'voyage-4-large';
// Outbound timeout: Node fetch has no application-level timeout, so a stalled
// embedding connection would park callers (notably the /api/chat RAG path)
// until undici's ~300 s default fires. Same AbortSignal pattern as
// imageProcessor.js. Self-hosted models get a higher default — first request
// after idle can include model load time.
const VOYAGE_TIMEOUT_MS = 15000;
const OPENAI_EMBED_TIMEOUT_MS = 30000;

let _warnedUnknownProvider = false;
function embeddingProviderName() {
  const name = (process.env.EMBEDDING_PROVIDER || 'voyage').trim().toLowerCase();
  // A typo here would silently fall back to Voyage — warn once so the
  // operator sees why their openai settings are being ignored.
  if (name !== 'voyage' && name !== 'openai' && !_warnedUnknownProvider) {
    _warnedUnknownProvider = true;
    console.warn(`[embedding] Unknown EMBEDDING_PROVIDER "${name}" (expected "voyage" or "openai") — treating as voyage`);
  }
  return name;
}

function openAiEmbEnv() {
  return {
    baseUrl: (process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.EMBEDDING_MODEL || '',
    dimension: parseInt(process.env.EMBEDDING_DIMENSION || '', 10) || 0,
    timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '', 10) || OPENAI_EMBED_TIMEOUT_MS,
  };
}

/** Is the active embedding provider fully configured? (feature gate) */
function isEmbeddingConfigured() {
  if (embeddingProviderName() === 'openai') {
    const env = openAiEmbEnv();
    return !!(env.baseUrl && env.model && env.dimension > 0);
  }
  return !!process.env.VOYAGE_API_KEY;
}

/** Vector size of the active provider — sizes the Qdrant collection. */
function getEmbeddingDimension() {
  return embeddingProviderName() === 'openai' ? openAiEmbEnv().dimension : VOYAGE_DIMENSION;
}

/**
 * The model name that will actually embed — for WineEmbedding bookkeeping and
 * logs. In openai mode the requested model (a Voyage name from aiConfig) is
 * replaced by EMBEDDING_MODEL.
 */
function activeEmbeddingModel(requestedModel) {
  return embeddingProviderName() === 'openai'
    ? openAiEmbEnv().model
    : (requestedModel || DEFAULT_MODEL);
}

const { fetchWithRetry } = require('../utils/fetchRetry');

function retryOpts({ maxRetries, timeoutMs, label }) {
  return {
    maxRetries,
    timeoutMs,
    label,
    onRetry: (waitMs, attempt) =>
      console.warn(`[embedding] 429 rate-limited — waiting ${waitMs}ms (attempt ${attempt}/${maxRetries})`),
  };
}

/** Sort an OpenAI/Voyage-shaped data array by index and return the vectors. */
function vectorsInOrder(json) {
  return json.data.slice().sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function embedVoyage(texts, { model, maxRetries }) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not configured');
  }

  const body = JSON.stringify({ input: texts, model, output_dimension: VOYAGE_DIMENSION });
  const res = await fetchWithRetry(
    () => fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body,
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS)
    }),
    retryOpts({ maxRetries, timeoutMs: VOYAGE_TIMEOUT_MS, label: 'Voyage AI' })
  );

  return vectorsInOrder(await res.json());
}

async function embedOpenAi(texts, { maxRetries }) {
  if (!isEmbeddingConfigured()) {
    throw new Error('Embedding provider is not configured (EMBEDDING_BASE_URL / EMBEDDING_MODEL / EMBEDDING_DIMENSION required when EMBEDDING_PROVIDER=openai)');
  }
  const env = openAiEmbEnv();

  const headers = { 'Content-Type': 'application/json' };
  if (env.apiKey) headers.Authorization = `Bearer ${env.apiKey}`;

  // No dimensions param — OpenAI-compat servers vary in support; the model's
  // native size must match EMBEDDING_DIMENSION (validated below).
  const body = JSON.stringify({ input: texts, model: env.model });
  const res = await fetchWithRetry(
    () => fetch(`${env.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(env.timeoutMs)
    }),
    retryOpts({ maxRetries, timeoutMs: env.timeoutMs, label: 'Embedding provider' })
  );

  const vectors = vectorsInOrder(await res.json());
  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${texts.length} inputs — response is unusable`
    );
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== env.dimension) {
      throw new Error(
        `Embedding provider returned ${Array.isArray(v) ? v.length : typeof v}-dim vectors but EMBEDDING_DIMENSION=${env.dimension} — ` +
        `set EMBEDDING_DIMENSION to the model's real size and run a FULL embedding job to rebuild the collection`
      );
    }
  }
  return vectors;
}

/**
 * Embed one or more texts. Returns an array of float[] vectors in the same
 * order as the input array.
 *
 * @param {string[]} texts
 * @param {object}   opts
 * @param {string}   [opts.model]      – override the embedding model
 *                                       (voyage mode only — openai mode always
 *                                       uses EMBEDDING_MODEL)
 * @param {number}   [opts.maxRetries] – retry budget for 429 responses (default 6)
 * @returns {Promise<number[][]>}
 */
async function embed(texts, { model = DEFAULT_MODEL, maxRetries = 6 } = {}) {
  if (embeddingProviderName() === 'openai') {
    return embedOpenAi(texts, { maxRetries });
  }
  return embedVoyage(texts, { model, maxRetries });
}

/**
 * Convenience wrapper — embed a single string, return its vector.
 *
 * @param {string} text
 * @param {object} opts – forwarded to embed()
 * @returns {Promise<number[]>}
 */
async function embedSingle(text, opts = {}) {
  const [vector] = await embed([text], opts);
  return vector;
}

/**
 * Build the canonical text representation of a (WineDefinition, vintage) pair
 * that will be embedded. Changing this format invalidates existing embeddings
 * (detected via textHash in WineEmbedding).
 *
 * @param {object} wine    – populated WineDefinition (country.name, region.name, grapes[].name)
 * @param {string} vintage – e.g. '2019' or 'NV'
 * @returns {string}
 */
function buildEmbeddingText(wine, vintage) {
  const lines = [
    `Name: ${wine.name}`,
    `Producer: ${wine.producer}`,
    `Type: ${wine.type || 'unknown'}`,
    `Vintage: ${vintage}`
  ];
  if (wine.region?.name)   lines.push(`Region: ${wine.region.name}`);
  if (wine.country?.name)  lines.push(`Country: ${wine.country.name}`);
  const grapeNames = (wine.grapes || []).filter(g => g.name).map(g => g.name).join(', ');
  if (grapeNames)          lines.push(`Grapes: ${grapeNames}`);
  if (wine.appellation)    lines.push(`Appellation: ${wine.appellation}`);
  if (wine.classification) lines.push(`Classification: ${wine.classification}`);

  // Fold in the AI tasting/style profile when present, so the embedding encodes
  // taste & pairing — not just identity. The structured descriptors (not the
  // prose) are used here: they're compact, comparable, and embed cleanly. When
  // a wine has no profile yet, the text is unchanged (so its hash/vector stay
  // stable until enrichment runs).
  const ap = wine.aiProfile;
  if (ap) {
    const style = [
      ap.body && `${ap.body}-bodied`,
      ap.tannin && `${ap.tannin} tannin`,
      ap.acidity && `${ap.acidity} acidity`,
      ap.sweetness,
    ].filter(Boolean).join(', ');
    if (style)                       lines.push(`Style: ${style}`);
    if (ap.flavors?.length)          lines.push(`Flavours: ${ap.flavors.join(', ')}`);
    if (ap.foodPairings?.length)     lines.push(`Pairs with: ${ap.foodPairings.join(', ')}`);
  }
  return lines.join('\n');
}

// Note: VOYAGE_DIMENSION is intentionally NOT exported — collection sizing
// must go through getEmbeddingDimension() so openai-mode dimensions apply.
module.exports = {
  embed,
  embedSingle,
  buildEmbeddingText,
  embeddingProviderName,
  isEmbeddingConfigured,
  getEmbeddingDimension,
  activeEmbeddingModel,
};
