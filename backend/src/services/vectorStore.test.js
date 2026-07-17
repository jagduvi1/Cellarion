/**
 * Qdrant client — outbound-timeout contract (SECURITY_AUDIT L-8).
 *
 * Same rationale as embedding.test.js: every Qdrant fetch must carry an
 * AbortSignal so a stalled connection can't park the chat route, and a
 * timeout must surface as the same plain-Error shape callers already handle
 * for Qdrant connection failures (graceful degrade).
 */
const vectorStore = require('./vectorStore');

describe('qdrant fetches', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('searchSimilar passes an abort (timeout) signal to fetch', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: [{ id: 'p1', score: 0.9, payload: { vintage: '2019' } }] }),
    });

    const hits = await vectorStore.searchSimilar('v1', [0.1, 0.2], 5);

    expect(hits).toEqual([{ id: 'p1', score: 0.9, payload: { vintage: '2019' } }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const opts = global.fetch.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('upsertPoints passes an abort (timeout) signal to fetch', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await vectorStore.upsertPoints('v1', [{ id: 'p1', vector: [0.1], payload: {} }]);

    const opts = global.fetch.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('a timed-out fetch rejects with a plain Error naming the request', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    global.fetch.mockRejectedValue(timeoutErr);

    await expect(vectorStore.searchSimilar('v1', [0.1], 5))
      .rejects.toThrow(/Qdrant POST .* timed out/);
  });

  // Security audit L-5: optional Qdrant API-key auth, off by default.
  describe('QDRANT_API_KEY header', () => {
    const saved = process.env.QDRANT_API_KEY;
    afterEach(() => {
      if (saved === undefined) delete process.env.QDRANT_API_KEY;
      else process.env.QDRANT_API_KEY = saved;
    });

    test('no api-key header is sent when QDRANT_API_KEY is unset', async () => {
      delete process.env.QDRANT_API_KEY;
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ result: [] }) });
      await vectorStore.searchSimilar('v1', [0.1], 5);
      expect(global.fetch.mock.calls[0][1].headers['api-key']).toBeUndefined();
    });

    test('the api-key header is sent when QDRANT_API_KEY is set', async () => {
      process.env.QDRANT_API_KEY = 'secret-key';
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ result: [] }) });
      await vectorStore.searchSimilar('v1', [0.1], 5);
      expect(global.fetch.mock.calls[0][1].headers['api-key']).toBe('secret-key');
    });
  });
});
