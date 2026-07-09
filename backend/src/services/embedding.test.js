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
const { embed } = require('./embedding');

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
