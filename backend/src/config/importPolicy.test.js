/**
 * config/importPolicy — how this server treats the wines an import brings in.
 *
 * WHY THIS TEST EXISTS:
 * Both switches change what is stored for every member, so each must fail to
 * the behaviour a server had before the switch existed: the AI look-up stays
 * on, and new wines are published as they are created, when nothing is
 * stored, when the stored value is not a real true/false, and when the
 * setting cannot be read. And holding wines back for a check must never
 * strand them: it only applies while the server reviews contributions at all.
 */
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const contributionReview = require('./contributionReview');
const config = require('./importPolicy');

const stored = (value) => SiteConfig.findOne.mockReturnValue({
  lean: async () => (value === undefined ? null : { value, updatedAt: new Date('2026-11-27T12:00:00Z') }),
});

beforeEach(() => {
  jest.clearAllMocks();
  config.set({});
  contributionReview.set({ enabled: true });
});
afterAll(() => contributionReview.set({ enabled: true }));

test('by default the import asks the AI and publishes new wines at once', async () => {
  expect(config.get()).toEqual({ aiLookup: true, checkNewWines: false, updatedAt: null });
  stored(undefined);
  await config.load();
  expect(config.usesAi()).toBe(true);
  expect(config.checksNewWines()).toBe(false);
});

test('the stored switches are read, with the time they were saved', async () => {
  stored({ aiLookup: false, checkNewWines: true });
  await config.load();
  expect(config.get()).toEqual({ aiLookup: false, checkNewWines: true, updatedAt: '2026-11-27T12:00:00.000Z' });
  expect(config.usesAi()).toBe(false);
  expect(config.checksNewWines()).toBe(true);
});

test('only a real false turns the look-up off, and only a real true holds new wines back', async () => {
  for (const value of [{ aiLookup: 'false', checkNewWines: 'true' }, { aiLookup: 0, checkNewWines: 1 }, {}]) {
    stored(value);
    await config.load();
    expect(config.usesAi()).toBe(true);
    expect(config.checksNewWines()).toBe(false);
  }
});

test('an unreadable setting keeps what was there', async () => {
  SiteConfig.findOne.mockImplementation(() => { throw new Error('db down'); });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await config.load();
  warn.mockRestore();
  expect(config.usesAi()).toBe(true);
  expect(config.checksNewWines()).toBe(false);
});

test('new wines are not held back on a server that does not review contributions: nobody works that queue', () => {
  config.set({ checkNewWines: true });
  expect(config.checksNewWines()).toBe(true);
  contributionReview.set({ enabled: false });
  expect(config.checksNewWines()).toBe(false);
  // The stored switch is untouched: turning review back on restores the check.
  expect(config.get().checkNewWines).toBe(true);
  contributionReview.set({ enabled: true });
  expect(config.checksNewWines()).toBe(true);
});
