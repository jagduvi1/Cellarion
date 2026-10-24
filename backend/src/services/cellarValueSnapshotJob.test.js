/**
 * The weekly cellar value snapshot stores every cellar's cost basis and
 * replacement value in USD (models/CellarValueSnapshot); the Stats chart
 * converts them back into the member's currency. So every amount must really
 * be USD when it is stored:
 *  - a foreign amount is converted with today's rates (rounded to cents);
 *  - when today's rates cannot be had, the newest stored rates of the last 7
 *    days stand in, so one failed fetch does not cost every member the week;
 *  - with no rates from that week either, the run is skipped — a missing
 *    weekly point beats one that sums SEK as if it were dollars;
 *  - an amount whose currency is not in the rates map is left out and
 *    counted, never added as if it were USD.
 */
jest.mock('../models/User', () => ({}));
jest.mock('../models/Cellar', () => ({ distinct: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/CellarValueSnapshot', () => ({ bulkWrite: jest.fn() }));
jest.mock('./valuation', () => ({ resolveReplacementForBottles: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  ...jest.requireActual('../utils/exchangeRates'),
  getOrCreateDailySnapshot: jest.fn(),
  getRecentSnapshot: jest.fn(),
}));

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const { resolveReplacementForBottles } = require('./valuation');
const { getOrCreateDailySnapshot, getRecentSnapshot } = require('../utils/exchangeRates');
const { runCellarValueSnapshots } = require('./cellarValueSnapshotJob');

const USER = 'u'.repeat(24);
const CELLAR = 'c'.repeat(24);
const RATES = { USD: 1, SEK: 10.5, EUR: 0.92 };

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
});

function setup({ bottles = [], replacements = new Map(), rates = RATES, recent = null } = {}) {
  getOrCreateDailySnapshot.mockResolvedValue(rates ? { date: '2026-10-25', rates } : null);
  getRecentSnapshot.mockResolvedValue(recent);
  Cellar.distinct.mockResolvedValue([USER]);
  Cellar.find.mockReturnValue(chain([{ _id: CELLAR }]));
  Bottle.find.mockReturnValue(chain(bottles));
  resolveReplacementForBottles.mockResolvedValue(replacements);
  CellarValueSnapshot.bulkWrite.mockResolvedValue({});
}

const storedSet = () => CellarValueSnapshot.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;

let logSpy;
let warnSpy;
let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('runCellarValueSnapshots — currencies', () => {
  test('a SEK bottle is stored converted to USD, rounded to cents', async () => {
    setup({
      bottles: [{ _id: 'b1', cellar: CELLAR, price: 100, currency: 'SEK' }],
      replacements: new Map([['b1', { amount: 250, currency: 'SEK', source: 'currentRelease' }]]),
    });

    await runCellarValueSnapshots();

    expect(CellarValueSnapshot.bulkWrite).toHaveBeenCalledTimes(1);
    const set = storedSet();
    expect(set.totalValue).toBe(9.52); // 100 / 10.5
    expect(set.replacementValue).toBe(23.81); // 250 / 10.5
    expect(set.bottleCount).toBe(1);
    expect(getRecentSnapshot).not.toHaveBeenCalled();
  });

  test('without today\'s rates the newest stored rates of the last 7 days are used', async () => {
    setup({
      bottles: [{ _id: 'b1', cellar: CELLAR, price: 100, currency: 'SEK' }],
      rates: null,
      recent: { date: '2026-10-21', rates: { USD: 1, SEK: 10 } },
    });

    await runCellarValueSnapshots();

    expect(getRecentSnapshot).toHaveBeenCalledWith(7);
    expect(CellarValueSnapshot.bulkWrite).toHaveBeenCalledTimes(1);
    expect(storedSet().totalValue).toBe(10); // 100 / 10, the stored day's rate
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).toMatch(/2026-10-21/);
  });

  test('a failing rates lookup falls back to the stored rates the same way', async () => {
    setup({
      bottles: [{ _id: 'b1', cellar: CELLAR, price: 100, currency: 'SEK' }],
      recent: { date: '2026-10-20', rates: { USD: 1, SEK: 10 } },
    });
    getOrCreateDailySnapshot.mockRejectedValue(new Error('upstream down'));

    await runCellarValueSnapshots();

    expect(CellarValueSnapshot.bulkWrite).toHaveBeenCalledTimes(1);
    expect(storedSet().totalValue).toBe(10);
  });

  test('with no rates today nor from the last 7 days the run is skipped with one warning and nothing is stored', async () => {
    setup({
      bottles: [{ _id: 'b1', cellar: CELLAR, price: 100, currency: 'SEK' }],
      rates: null,
    });

    await expect(runCellarValueSnapshots()).resolves.toBeUndefined();

    expect(getRecentSnapshot).toHaveBeenCalledWith(7);
    expect(CellarValueSnapshot.bulkWrite).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('a failing rates lookup with no stored rates to fall back on skips the run the same way', async () => {
    setup({ bottles: [{ _id: 'b1', cellar: CELLAR, price: 100, currency: 'SEK' }] });
    getOrCreateDailySnapshot.mockRejectedValue(new Error('upstream down'));
    getRecentSnapshot.mockRejectedValue(new Error('db down'));

    await expect(runCellarValueSnapshots()).resolves.toBeUndefined();

    expect(CellarValueSnapshot.bulkWrite).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('an amount in a currency the rates lack is skipped and counted; USD amounts still sum', async () => {
    setup({
      bottles: [
        { _id: 'b1', cellar: CELLAR, price: 40, currency: 'USD' },
        { _id: 'b2', cellar: CELLAR, price: 5000, currency: 'XYZ' },
      ],
      replacements: new Map([
        ['b1', { amount: 60, currency: 'USD', source: 'currentRelease' }],
        ['b2', { amount: 5000, currency: 'XYZ', source: 'paid' }],
      ]),
    });

    await runCellarValueSnapshots();

    const set = storedSet();
    expect(set.totalValue).toBe(40);
    expect(set.replacementValue).toBe(60);
    expect(set.bottleCount).toBe(2);
    const summary = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(summary).toMatch(/2 amount\(s\) skipped/);
  });
});
