/**
 * resultCache — real-execution coverage (grand-audit M24).
 *
 * Tool suites only asserted "no recompute on repeat" and dodged the shared
 * module-level cache via unique user ids, so TTL expiry, the evict-oldest-half
 * branch, and per-user busting never ran.
 */

const { cachedResult, TTL_MS } = require('./resultCache');

let now = 5_000_000;
beforeEach(() => jest.spyOn(Date, 'now').mockImplementation(() => now));
afterEach(() => jest.restoreAllMocks());

test('serves the cached value on a repeat within the TTL (no recompute)', async () => {
  const compute = jest.fn().mockResolvedValue({ n: 1 });
  const a = await cachedResult('tool', 'uA', 'v', compute);
  const b = await cachedResult('tool', 'uA', 'v', compute);
  expect(a).toBe(b);
  expect(compute).toHaveBeenCalledTimes(1);
});

test('recomputes once the TTL has elapsed', async () => {
  const compute = jest.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 });
  await cachedResult('tool', 'uB', 'v', compute);
  now += TTL_MS + 1;
  const second = await cachedResult('tool', 'uB', 'v', compute);
  expect(second).toEqual({ n: 2 });
  expect(compute).toHaveBeenCalledTimes(2);
});

test('a different variant is a different cache entry', async () => {
  const compute = jest.fn().mockResolvedValue({});
  await cachedResult('tool', 'uC', 'v1', compute);
  await cachedResult('tool', 'uC', 'v2', compute);
  expect(compute).toHaveBeenCalledTimes(2);
});
// (bustUser per-user invalidation is covered on the cache-bust batch that adds it.)
