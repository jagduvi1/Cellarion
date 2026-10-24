/**
 * config/runtime — loads the four settings caches an admin changes at run time
 * (rate limits, AI settings, the announcement banner, feature flags).
 *
 * WHY THIS TEST EXISTS:
 * server.js awaits loadRuntimeConfig() before the migrations, the scheduler
 * and app.listen, so it must load every cache exactly once, resolve only when
 * all of them are in, and never reject: a config that cannot be read keeps
 * its code defaults and the server still starts.
 */

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

jest.mock('./rateLimits', () => ({ load: jest.fn() }));
jest.mock('./aiConfig', () => ({ load: jest.fn() }));
jest.mock('./announcement', () => ({ load: jest.fn() }));
jest.mock('./featureFlags', () => ({ load: jest.fn() }));

const rateLimits = require('./rateLimits');
const aiConfig = require('./aiConfig');
const announcement = require('./announcement');
const featureFlags = require('./featureFlags');
const { loadRuntimeConfig } = require('./runtime');

const CONFIGS = { rateLimits, aiConfig, announcement, featureFlags };

let warn;
beforeEach(() => {
  jest.clearAllMocks();
  for (const config of Object.values(CONFIGS)) config.load.mockResolvedValue(undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

test('loads each of the four configs exactly once', async () => {
  await loadRuntimeConfig();
  for (const config of Object.values(CONFIGS)) expect(config.load).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

test('resolves only after every load has resolved, whatever order they finish in', async () => {
  const pending = {};
  for (const [name, config] of Object.entries(CONFIGS)) {
    pending[name] = deferred();
    config.load.mockReturnValue(pending[name].promise);
  }
  let done = false;
  const run = loadRuntimeConfig().then(() => { done = true; });

  for (const name of ['featureFlags', 'rateLimits', 'announcement']) {
    pending[name].resolve();
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
  }
  pending.aiConfig.resolve();
  await run;
  expect(done).toBe(true);
});

test('a load that rejects keeps its defaults: the others still load and the call resolves', async () => {
  aiConfig.load.mockRejectedValue(new Error('read failed'));
  await expect(loadRuntimeConfig()).resolves.toBeUndefined();
  for (const config of Object.values(CONFIGS)) expect(config.load).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('[aiConfig] Startup load failed, using defaults:', 'read failed');
});

test('a load that throws before returning a promise cannot stop the others either', async () => {
  featureFlags.load.mockImplementation(() => { throw new Error('not ready'); });
  await expect(loadRuntimeConfig()).resolves.toBeUndefined();
  for (const config of Object.values(CONFIGS)) expect(config.load).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('[featureFlags] Startup load failed, using defaults:', 'not ready');
});
