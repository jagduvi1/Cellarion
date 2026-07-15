/**
 * Voyage embedding client — outbound-timeout contract (SECURITY_AUDIT L-8).
 *
 * Node fetch has no application-level timeout; a stalled Voyage connection
 * would park the /api/chat RAG path until undici's ~300 s default fires.
 * These tests pin two behaviours:
 *   1. every Voyage fetch carries an AbortSignal (the timeout),
 *   2. a timeout abort surfaces as the same plain-Error shape callers
 *      already handle for Voyage failures (graceful degrade, no retry loop).
 */
const {
  embed,
  isEmbeddingConfigured,
  getEmbeddingDimension,
  activeEmbeddingModel,
  embeddingProviderName,
  VOYAGE_DIMENSION,
} = require('./embedding');

describe('embed (Voyage fetch)', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete process.env.VOYAGE_API_KEY;
    global.fetch = realFetch;
  });

  test('passes an abort (timeout) signal to fetch', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
    });

    const vectors = await embed(['hello']);

    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const opts = global.fetch.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('a timed-out fetch rejects with a plain Error (no retry loop, no crash shape)', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    global.fetch.mockRejectedValue(timeoutErr);

    await expect(embed(['hello'])).rejects.toThrow(/Voyage AI request timed out/);
    // Timeouts are not retried like 429s — one attempt only.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('non-timeout network errors propagate unchanged', async () => {
    global.fetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(embed(['hello'])).rejects.toThrow('fetch failed');
  });
});

/**
 * OpenAI-compatible embedding provider (issue #698, phase 2).
 * EMBEDDING_PROVIDER=openai routes embed() to {EMBEDDING_BASE_URL}/embeddings
 * and validates every vector against EMBEDDING_DIMENSION.
 */
describe('embed (OpenAI-compatible provider)', () => {
  const realFetch = global.fetch;
  const ENV_KEYS = [
    'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY',
    'EMBEDDING_MODEL', 'EMBEDDING_DIMENSION', 'EMBEDDING_TIMEOUT_MS',
    'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'VOYAGE_API_KEY',
  ];
  const saved = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.EMBEDDING_BASE_URL = 'http://llm.local/v1/';
    process.env.EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.EMBEDDING_DIMENSION = '3';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    global.fetch = realFetch;
  });

  test('config helpers reflect the active provider', () => {
    expect(embeddingProviderName()).toBe('openai');
    expect(isEmbeddingConfigured()).toBe(true);
    expect(getEmbeddingDimension()).toBe(3);
    // Voyage model names from aiConfig are replaced by EMBEDDING_MODEL
    expect(activeEmbeddingModel('voyage-4-large')).toBe('nomic-embed-text');

    delete process.env.EMBEDDING_DIMENSION;
    expect(isEmbeddingConfigured()).toBe(false);

    delete process.env.EMBEDDING_PROVIDER;
    expect(embeddingProviderName()).toBe('voyage');
    expect(getEmbeddingDimension()).toBe(VOYAGE_DIMENSION);
    expect(activeEmbeddingModel('voyage-4-large')).toBe('voyage-4-large');
    expect(isEmbeddingConfigured()).toBe(false); // no VOYAGE_API_KEY
  });

  test('posts to {base}/embeddings with the env model and returns vectors in input order', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [4, 5, 6] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      }),
    });

    const vectors = await embed(['a', 'b'], { model: 'voyage-4-large' });

    expect(vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://llm.local/v1/embeddings');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('nomic-embed-text'); // Voyage name ignored
    expect(body.input).toEqual(['a', 'b']);
    expect(body.output_dimension).toBeUndefined();
    expect(opts.headers.Authorization).toBeUndefined(); // no key set
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('falls back to OPENAI_BASE_URL / OPENAI_API_KEY when EMBEDDING_* are unset', async () => {
    delete process.env.EMBEDDING_BASE_URL;
    process.env.OPENAI_BASE_URL = 'http://shared.local/v1';
    process.env.OPENAI_API_KEY = 'shared-key';
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });

    await embed(['a']);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://shared.local/v1/embeddings');
    expect(opts.headers.Authorization).toBe('Bearer shared-key');
  });

  test('rejects vectors that do not match EMBEDDING_DIMENSION (collection-corruption guard)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }), // 4 ≠ 3
    });

    await expect(embed(['a'])).rejects.toThrow(/EMBEDDING_DIMENSION=3/);
  });

  test('throws a clear config error when required env is missing', async () => {
    delete process.env.EMBEDDING_MODEL;
    await expect(embed(['a'])).rejects.toThrow(/not configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('timeouts surface as the same plain-Error shape as Voyage timeouts', async () => {
    const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    global.fetch.mockRejectedValue(timeoutErr);
    await expect(embed(['a'])).rejects.toThrow(/Embedding provider request timed out/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
