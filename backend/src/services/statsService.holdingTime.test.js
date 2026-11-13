/**
 * The "how long you kept them" chart (holdingTime) counts the days from the
 * purchase, else from the day the bottle was added, to the day it was drunk.
 *
 * WHY THIS TEST EXISTS:
 * A drink can be logged after the fact with its real date (the drink dialog,
 * the bulk "mark as drunk", the MCP consume_bottle consumed_at). A drinking
 * history typed in from another app is added today and drunk years ago, so
 * its holding time is unknown. Counted anyway, it comes out negative and
 * lands in "under a year".
 */
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  convertCurrency: jest.fn((amt) => amt),
}));
jest.mock('../models/WineVintageProfile', () => ({
  find: jest.fn(() => ({ lean: () => Promise.resolve([]) })),
}));

const { computeOverview } = require('./statsService');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-13T15:00:00Z'));
});
afterAll(() => jest.useRealTimers());

const drunk = (fields) => ({
  cellar: 'c1', vintage: '2015', status: 'drank', consumedReason: 'drank',
  wineDefinition: { _id: 'wd1', type: 'red' }, ...fields,
});

const holding = async (consumedBottles) => {
  const stats = await computeOverview({
    activeBottles: [],
    consumedBottles,
    cellars: [{ _id: 'c1', name: 'Main' }],
    targetCurrency: 'USD',
    targetRatingScale: '100',
  });
  return Object.fromEntries(stats.holdingTime.map((d) => [d.bucket, d.count]));
};

test('a bottle added today and logged as drunk in 2023 has no known holding time: it is left out', async () => {
  const counts = await holding([
    drunk({ createdAt: new Date('2026-11-13T14:00:00Z'), consumedAt: new Date('2023-05-20T12:00:00Z') }),
  ]);
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
});

test('a bottle bought in 2020 and drunk in 2023 counts from the purchase: 2–5 years', async () => {
  const counts = await holding([
    drunk({
      purchaseDate: new Date('2020-03-01T12:00:00Z'),
      createdAt: new Date('2026-11-13T14:00:00Z'),
      consumedAt: new Date('2023-05-20T12:00:00Z'),
    }),
  ]);
  expect(counts['2–5yr']).toBe(1);
});

test('added and drunk the same day, the date-only drink day at noon UTC before the add: under a year', async () => {
  const counts = await holding([
    drunk({ createdAt: new Date('2026-11-13T14:00:00Z'), consumedAt: new Date('2026-11-13T12:00:00Z') }),
  ]);
  expect(counts['<1yr']).toBe(1);
});
