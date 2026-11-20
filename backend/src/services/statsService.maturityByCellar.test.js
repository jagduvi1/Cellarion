/**
 * Maturity per cellar: each cellarBreakdown row carries its own maturity
 * buckets and Regret Index, counted in the same pass as the overall ones, so
 * the Statistics page can show a forgotten cellar beside the others. The rows
 * must add up to the overall counts, or the table and the chart above it
 * would disagree.
 *
 * Phases come from personal drink windows (no profile lookup needed); the
 * rate snapshot and the profile model are mocked, so no MongoDB is needed.
 */

jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  convertCurrency: jest.fn((amt) => amt),
}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));

const { computeOverview, buildEmptyStats } = require('./statsService');
const WineVintageProfile = require('../models/WineVintageProfile');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
});
afterAll(() => jest.useRealTimers());

const KEYS = ['declining', 'late', 'peak', 'early', 'notReady', 'noProfile'];

// Personal windows that put a bottle in each phase in 2026.
const WINDOW = {
  declining: { drinkFrom: 2016, drinkTo: 2020 },
  late:      { drinkFrom: 2018, peakUntil: 2024 },
  peak:      { drinkFrom: 2024, drinkTo: 2030 },
  early:     { drinkFrom: 2025, peakFrom: 2028 },
  notReady:  { drinkFrom: 2030 },
  noProfile: {},
};

let n = 0;
const bottle = (cellar, phase) => ({
  _id: `b${++n}`, cellar, vintage: '2018', wineDefinition: { _id: `wd${n}` }, ...WINDOW[phase],
});

const CELLARS = [{ _id: 'cA', name: 'House' }, { _id: 'cB', name: 'Summer house' }, { _id: 'cC', name: 'Unprofiled' }];

const run = (activeBottles) => {
  WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([]) });
  return computeOverview({
    activeBottles, consumedBottles: [], cellars: CELLARS, targetCurrency: 'USD', targetRatingScale: '5',
  });
};

const rowOf = (stats, id) => stats.cellarBreakdown.find((c) => c.id === id);

describe('cellarBreakdown maturity per cellar', () => {
  const bottles = () => [
    // House: 1 declining of 4 with a window → 25 %.
    bottle('cA', 'declining'), bottle('cA', 'late'), bottle('cA', 'peak'), bottle('cA', 'early'), bottle('cA', 'noProfile'),
    // Summer house: 2 declining of 3 with a window → 67 %.
    bottle('cB', 'declining'), bottle('cB', 'declining'), bottle('cB', 'notReady'),
    // Unprofiled: no bottle with a window.
    bottle('cC', 'noProfile'), bottle('cC', 'noProfile'),
  ];

  test('each row is classified as the overall counts are, and the rows add up to them', async () => {
    const stats = await run(bottles());
    expect(stats.maturity).toEqual({ declining: 3, late: 1, peak: 1, early: 1, notReady: 1, noProfile: 3 });
    for (const key of KEYS) {
      const sum = stats.cellarBreakdown.reduce((s, c) => s + c.maturity[key], 0);
      expect(sum).toBe(stats.maturity[key]);
    }
    // Every bottle of a cellar lands in exactly one of its buckets.
    for (const c of stats.cellarBreakdown) {
      expect(KEYS.reduce((s, k) => s + c.maturity[k], 0)).toBe(c.bottleCount);
    }
    expect(rowOf(stats, 'cA').maturity).toEqual({ declining: 1, late: 1, peak: 1, early: 1, notReady: 0, noProfile: 1 });
    expect(rowOf(stats, 'cB').maturity).toEqual({ declining: 2, late: 0, peak: 0, early: 0, notReady: 1, noProfile: 0 });
  });

  test("each cellar's Regret Index uses the overall formula on its own bottles", async () => {
    const stats = await run(bottles());
    expect(rowOf(stats, 'cA').regretIndex).toBe(25);
    expect(rowOf(stats, 'cB').regretIndex).toBe(67);
    // Overall: 3 declining of 7 with a window, unchanged by the per-cellar rows.
    expect(stats.overview.regretIndex).toBe(43);
  });

  test('a cellar with no drink windows has every bottle in noProfile and a Regret Index of 0', async () => {
    const stats = await run(bottles());
    expect(rowOf(stats, 'cC')).toMatchObject({
      bottleCount: 2,
      maturity: { declining: 0, late: 0, peak: 0, early: 0, notReady: 0, noProfile: 2 },
      regretIndex: 0,
    });
  });

  test('the documented row fields are unchanged', async () => {
    const stats = await run(bottles());
    expect(rowOf(stats, 'cA')).toEqual({
      id: 'cA', name: 'House', bottleCount: 5, value: 0, uniqueWines: 5,
      maturity: expect.any(Object), regretIndex: 25,
    });
  });
});

describe('the empty shape', () => {
  test('no cellars: no rows, the same maturity keys, a Regret Index of 0', () => {
    const empty = buildEmptyStats('USD', '5');
    expect(empty.cellarBreakdown).toEqual([]);
    expect(Object.keys(empty.maturity)).toEqual(KEYS);
    expect(empty.overview.regretIndex).toBe(0);
  });

  test('cellars without bottles: no rows, and the overall buckets have the same keys a row has', async () => {
    const empty = await run([]);
    expect(empty.cellarBreakdown).toEqual([]);
    expect(empty.maturity).toEqual(buildEmptyStats('USD', '5').maturity);

    const one = await run([bottle('cA', 'peak')]);
    expect(Object.keys(one.cellarBreakdown[0].maturity)).toEqual(Object.keys(empty.maturity));
  });
});
