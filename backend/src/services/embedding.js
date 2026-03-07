/**
 * Voyage AI embedding service.
 *
 * Wraps the Voyage AI REST API (/v1/embeddings) using Node's built-in fetch.
 * voyage-4-lite produces 1 024-dimensional vectors.
 *
 * Throttle strategy
 * -----------------
 * The free tier allows 3 requests per minute. Any 429 response is retried
 * with truncated exponential backoff + jitter (initial 2 s, doubles each
 * attempt, capped at 64 s). A Retry-After header is honoured when present.
 * Permanent errors (4xx other than 429, 5xx after max retries) are thrown.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_DIMENSION = 1024;
const DEFAULT_MODEL = 'voyage-4-lite';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Embed one or more texts. Returns an array of float[] vectors in the same
 * order as the input array.
 *
 * @param {string[]} texts
 * @param {object}   opts
 * @param {string}   [opts.model]      – override the embedding model
 * @param {number}   [opts.maxRetries] – retry budget for 429 responses (default 6)
 * @returns {Promise<number[][]>}
 */
async function embed(texts, { model = DEFAULT_MODEL, maxRetries = 6 } = {}) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not configured');
  }

  let delay = 2000; // ms — initial backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: texts, model })
    });

    if (res.ok) {
      const json = await res.json();
      // Sort by index to guarantee order matches input
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      return sorted.map(d => d.embedding);
    }

    if (res.status === 429 && attempt < maxRetries) {
      // Honour Retry-After if present; otherwise use exponential backoff + jitter
      const retryAfter = res.headers.get('retry-after');
      let waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : delay + Math.floor(Math.random() * 500);

      console.warn(`[embedding] 429 rate-limited — waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      delay = Math.min(delay * 2, 64000);
      continue;
    }

    // Non-retryable error
    let body = '';
    try { body = await res.text(); } catch (_) { /* ignore */ }
    throw Object.assign(
      new Error(`Voyage AI error ${res.status}: ${body}`),
      { status: res.status }
    );
  }

  throw new Error(`Voyage AI: exceeded ${maxRetries} retries due to rate limiting`);
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
  return lines.join('\n');
}

module.exports = { embed, embedSingle, buildEmbeddingText, VOYAGE_DIMENSION };
