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

// bustUser + eviction (MCP-audit M11 — both were untested; the commit that
// added them claimed coverage that didn't exist). Fresh module per test so the
// shared module-level cache from the tests above doesn't skew the boundaries.
describe('bustUser + eviction', () => {
  let cachedResult, bustUser;
  beforeEach(() => {
    jest.resetModules();
    ({ cachedResult, bustUser } = require('./resultCache'));
  });

  test('bustUser drops ONLY the target user\'s entries (a just-mutated cellar recomputes)', async () => {
    const compute = jest.fn().mockResolvedValue({});
    await cachedResult('t', 'uX', 'v', compute);
    await cachedResult('t', 'uY', 'v', compute);
    bustUser('uX');
    await cachedResult('t', 'uX', 'v', compute); // busted → recompute
    await cachedResult('t', 'uY', 'v', compute); // untouched → still cached
    expect(compute).toHaveBeenCalledTimes(3); // uX×2, uY×1
  });

  test('the :userId: needle is exact — a substring userId is not busted', async () => {
    const compute = jest.fn().mockResolvedValue({});
    await cachedResult('t', 'u1', 'v', compute);
    await cachedResult('t', 'u12', 'v', compute); // key t:u12:v does NOT contain :u1:
    bustUser('u1');
    await cachedResult('t', 'u12', 'v', compute); // survives
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test('at CACHE_MAX it evicts the oldest half, not everyone (no cold-start)', async () => {
    const CACHE_MAX = 2000;
    const compute = jest.fn().mockResolvedValue({});
    for (let i = 0; i < CACHE_MAX; i++) await cachedResult('t', `u${i}`, 'v', compute);
    expect(compute).toHaveBeenCalledTimes(CACHE_MAX);
    await cachedResult('t', 'uNEW', 'v', compute); // size hits cap → evict u0..u999
    await cachedResult('t', 'u0', 'v', compute);   // oldest → evicted → recompute
    await cachedResult('t', 'u1999', 'v', compute); // recent → survived → cached
    expect(compute).toHaveBeenCalledTimes(CACHE_MAX + 2); // uNEW + u0 recompute only
  });
});
