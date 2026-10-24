/**
 * getRecentSnapshot — the newest stored day of rates no older than N days.
 * A job that must not lose its run to one failed fetch (the weekly cellar
 * value snapshot) reads it when today's rates cannot be had.
 */
jest.mock('../models/ExchangeRateSnapshot', () => ({ findOne: jest.fn() }));

const ExchangeRateSnapshot = require('../models/ExchangeRateSnapshot');
const { getRecentSnapshot } = require('./exchangeRates');

const chain = (doc) => {
  const c = { sort: jest.fn(() => c), lean: jest.fn(async () => doc) };
  return c;
};

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-24T03:00:00Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

test('reads the newest snapshot dated on or after the cutoff day', async () => {
  const doc = { date: '2026-10-21', rates: { USD: 1, SEK: 10 } };
  const c = chain(doc);
  ExchangeRateSnapshot.findOne.mockReturnValue(c);

  await expect(getRecentSnapshot(7)).resolves.toBe(doc);

  expect(ExchangeRateSnapshot.findOne).toHaveBeenCalledWith({ date: { $gte: '2026-10-17' } });
  expect(c.sort).toHaveBeenCalledWith({ date: -1 });
});

test('no snapshot inside the window is null', async () => {
  ExchangeRateSnapshot.findOne.mockReturnValue(chain(null));

  await expect(getRecentSnapshot(7)).resolves.toBeNull();
});
