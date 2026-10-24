/**
 * scripts/lib/scriptSearch: Meilisearch for a standalone script.
 *
 * services/search does nothing until initialize() has run: indexWine,
 * removeWine and fullSync return without a word. The server's boot runs it;
 * a script has to run it itself, wait for it, and say so when Meilisearch
 * cannot be reached. indexWine also populates the wine's country, region and
 * grapes, so those models must be registered in the script's process or every
 * call fails inside indexWine's own catch.
 */

jest.mock('../../services/search', () => ({
  initialize: jest.fn(),
  getIsAvailable: jest.fn(),
}));

const mongoose = require('mongoose');
const searchService = require('../../services/search');
const { initSearch } = require('./scriptSearch');

let warn;
beforeEach(() => {
  searchService.initialize.mockReset().mockResolvedValue(undefined);
  searchService.getIsAvailable.mockReset().mockReturnValue(true);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('initialises search once, without the boot-time background sync, and returns the availability', async () => {
  await expect(initSearch({ label: 'some-script' })).resolves.toBe(true);

  expect(searchService.initialize).toHaveBeenCalledTimes(1);
  expect(searchService.initialize).toHaveBeenCalledWith({ sync: false });
});

test('resolves only once initialize() has finished, so the first index call finds search available', async () => {
  let available = false;
  searchService.getIsAvailable.mockImplementation(() => available);
  searchService.initialize.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    available = true;
  });

  await expect(initSearch({ label: 'some-script' })).resolves.toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

test('when Meilisearch is unavailable it warns once, naming the script, and returns false', async () => {
  searchService.getIsAvailable.mockReturnValue(false);

  await expect(initSearch({ label: 'some-script' })).resolves.toBe(false);

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/^\[some-script\] Meilisearch unavailable/);
  expect(warn.mock.calls[0][0]).toMatch(/\/api\/admin\/search\/reindex/);
});

test('when Meilisearch is available it does not warn', async () => {
  await initSearch({ label: 'some-script' });
  expect(warn).not.toHaveBeenCalled();
});

test('registers every model indexWine populates (country, region, grapes)', () => {
  const WineDefinition = require('../../models/WineDefinition');
  const refOf = (p) => {
    const type = WineDefinition.schema.path(p);
    return type.options.ref || type.caster?.options?.ref;
  };

  for (const p of ['country', 'region', 'grapes']) {
    const ref = refOf(p);
    expect(ref).toBeTruthy();
    expect(mongoose.modelNames()).toContain(ref);
  }
});
