/**
 * config/contributionReview — whether this server reviews contributions.
 *
 * WHY THIS TEST EXISTS:
 * Review is what keeps a shared registry (cellarion.app) clean, so the switch
 * must fail SAFE: on by default, on when nothing is stored, on when the
 * stored setting cannot be read. Only an explicit `enabled: false` turns it
 * off.
 */
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const config = require('./contributionReview');

const stored = (value) => SiteConfig.findOne.mockReturnValue({ lean: async () => (value === undefined ? null : { value, updatedAt: new Date('2026-11-04T12:00:00Z') }) });

beforeEach(() => { jest.clearAllMocks(); config.set({ enabled: true }); });

test('on by default and when nothing is stored', async () => {
  expect(config.isOn()).toBe(true);
  stored(undefined);
  await config.load();
  expect(config.isOn()).toBe(true);
});

test('off only for an explicit enabled: false', async () => {
  stored({ enabled: false });
  await config.load();
  expect(config.isOn()).toBe(false);
  expect(config.get()).toEqual({ enabled: false, updatedAt: '2026-11-04T12:00:00.000Z' });

  for (const value of [{ enabled: 'false' }, { enabled: 0 }, {}]) {
    config.set({ enabled: false });
    stored(value);
    await config.load();
    expect(config.isOn()).toBe(true);
  }
});

test('an unreadable setting keeps review on', async () => {
  config.set({ enabled: true });
  SiteConfig.findOne.mockReturnValue({ lean: async () => { throw new Error('db down'); } });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await config.load();
  expect(config.isOn()).toBe(true);
  warn.mockRestore();
});

test('set() hot-reloads, and anything but false means on', () => {
  config.set({ enabled: false });
  expect(config.isOn()).toBe(false);
  config.set({});
  expect(config.isOn()).toBe(true);
});
