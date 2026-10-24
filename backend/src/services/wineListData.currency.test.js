/**
 * A wine list's average purchase price per entry (services/wineListData) —
 * printed on the PDF and the web menu when the owner set no list price, and
 * the cost side of the margin stats. Each bottle's price is in that bottle's
 * own currency, so the average is currency-aware:
 *  - priced bottles of one entry all in the list's currency: their plain
 *    average;
 *  - in any other currency, one or several: the count-weighted average in the
 *    list's currency, converted with today's rates;
 *  - a currency that cannot be converted: no average rather than a price in
 *    the wrong unit or a sum of mixed units;
 *  - no list currency to convert into (the editor's picker): one currency
 *    keeps its plain average, several have none.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  ...jest.requireActual('../utils/exchangeRates'),
  getOrCreateDailySnapshot: jest.fn(),
}));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { loadWineMap, loadCellarWines } = require('./wineListData');

const oid = (c) => c.repeat(24);
const OWNER = oid('1');
const CELLAR = oid('c');
const WINE = oid('a');
const KEY = `${WINE}|2019|750ml`;
const RATES = { USD: 1, EUR: 0.5, SEK: 10 };

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
  }),
});

/** One $group row: the bottles of one entry that share one currency. */
const group = (currency, { stock, priced = stock, priceSum }) => ({
  _id: { wine: WINE, vintage: '2019', bottleSize: '750ml', currency },
  stock,
  priced,
  priceSum,
});

const list = (currency) => ({
  user: OWNER,
  cellar: CELLAR,
  structureMode: 'auto',
  autoGroupEntries: [{ wine: WINE, vintage: '2019', bottleSize: '750ml' }],
  layout: { currency },
});

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(chain([{ _id: WINE, name: 'Barolo' }]));
  Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([CELLAR]) });
  Bottle.distinct.mockResolvedValue([]);
  getOrCreateDailySnapshot.mockResolvedValue({ date: '2026-10-24', rates: RATES });
});

describe('loadWineMap — average purchase price', () => {
  test('the stock aggregation keeps each bottle\'s currency apart', async () => {
    Bottle.aggregate.mockResolvedValue([]);
    await loadWineMap(list('USD'));
    const $group = Bottle.aggregate.mock.calls[0][0].find((s) => s.$group).$group;
    expect($group._id.currency).toBeDefined();
  });

  test('EUR and USD bottles of one entry average to the count-weighted mean in the list currency', async () => {
    Bottle.aggregate.mockResolvedValue([
      group('EUR', { stock: 2, priceSum: 40 }), // 2 × 20 EUR = 2 × 40 USD
      group('USD', { stock: 1, priceSum: 10 }),
    ]);

    const info = (await loadWineMap(list('USD'))).get(KEY);

    expect(info.stock).toBe(3);
    expect(info.avgPrice).toBeCloseTo(30, 10); // (80 + 10) / 3
  });

  test('a currency the rates lack leaves the entry without an average', async () => {
    getOrCreateDailySnapshot.mockResolvedValue({ date: '2026-10-24', rates: { USD: 1, SEK: 10 } });
    Bottle.aggregate.mockResolvedValue([
      group('EUR', { stock: 2, priceSum: 40 }),
      group('USD', { stock: 1, priceSum: 10 }),
    ]);

    const info = (await loadWineMap(list('USD'))).get(KEY);

    expect(info.stock).toBe(3);
    expect(info.avgPrice).toBeNull();
  });

  test('no rates today leaves a mixed entry without an average', async () => {
    getOrCreateDailySnapshot.mockResolvedValue(null);
    Bottle.aggregate.mockResolvedValue([
      group('EUR', { stock: 1, priceSum: 20 }),
      group('SEK', { stock: 1, priceSum: 300 }),
    ]);

    const info = (await loadWineMap(list('SEK'))).get(KEY);

    expect(info.avgPrice).toBeNull();
  });

  test("an entry in the list's own currency keeps its plain average, without fetching rates", async () => {
    Bottle.aggregate.mockResolvedValue([group('SEK', { stock: 3, priceSum: 900 })]);

    const info = (await loadWineMap(list('SEK'))).get(KEY);

    expect(info.avgPrice).toBe(300);
    expect(getOrCreateDailySnapshot).not.toHaveBeenCalled();
  });

  test("an entry in ONE other currency is converted into the list's currency", async () => {
    Bottle.aggregate.mockResolvedValue([group('SEK', { stock: 3, priceSum: 900 })]);

    const info = (await loadWineMap(list('USD'))).get(KEY);

    expect(info.avgPrice).toBeCloseTo(30, 10); // 900 SEK = 90 USD, over 3
    expect(getOrCreateDailySnapshot).toHaveBeenCalledTimes(1);
  });

  test("an entry in one other currency has no average when today's rates are missing", async () => {
    getOrCreateDailySnapshot.mockResolvedValue(null);
    Bottle.aggregate.mockResolvedValue([group('EUR', { stock: 2, priceSum: 90 })]);

    const info = (await loadWineMap(list('SEK'))).get(KEY);

    expect(info.stock).toBe(2);
    expect(info.avgPrice).toBeNull();
  });

  test('an entry in one other currency the rates lack has no average', async () => {
    getOrCreateDailySnapshot.mockResolvedValue({ date: '2026-10-24', rates: { USD: 1, SEK: 10 } });
    Bottle.aggregate.mockResolvedValue([group('EUR', { stock: 2, priceSum: 90 })]);

    const info = (await loadWineMap(list('SEK'))).get(KEY);

    expect(info.avgPrice).toBeNull();
  });

  test('unpriced bottles (default currency) neither count in the average nor call for a conversion', async () => {
    Bottle.aggregate.mockResolvedValue([
      group('SEK', { stock: 2, priceSum: 600 }),
      group('USD', { stock: 3, priced: 0, priceSum: 0 }),
    ]);

    const info = (await loadWineMap(list('SEK'))).get(KEY);

    expect(info.stock).toBe(5);
    expect(info.avgPrice).toBe(300);
    expect(getOrCreateDailySnapshot).not.toHaveBeenCalled();
  });

  test('an alias and its code are one currency', async () => {
    Bottle.aggregate.mockResolvedValue([
      group('EURO', { stock: 1, priceSum: 10 }),
      group('EUR', { stock: 1, priceSum: 30 }),
    ]);

    const info = (await loadWineMap(list('EUR'))).get(KEY);

    expect(info.avgPrice).toBe(20);
    expect(getOrCreateDailySnapshot).not.toHaveBeenCalled();
  });

  test('an entry without any priced bottle has no average', async () => {
    Bottle.aggregate.mockResolvedValue([group('USD', { stock: 2, priced: 0, priceSum: 0 })]);

    const info = (await loadWineMap(list('USD'))).get(KEY);

    expect(info.stock).toBe(2);
    expect(info.avgPrice).toBeNull();
  });
});

describe('loadCellarWines — the editor picker has no list currency', () => {
  test('a mixed-currency wine has no average; a single-currency wine keeps its own', async () => {
    const OTHER = oid('b');
    Bottle.aggregate.mockResolvedValue([
      group('EUR', { stock: 1, priceSum: 20 }),
      group('USD', { stock: 1, priceSum: 10 }),
      { _id: { wine: OTHER, vintage: 'NV', bottleSize: '750ml', currency: 'SEK' }, stock: 2, priced: 2, priceSum: 500 },
    ]);
    WineDefinition.find.mockReturnValue(chain([{ _id: WINE, name: 'Barolo' }, { _id: OTHER, name: 'Cava' }]));

    const rows = await loadCellarWines(CELLAR);
    const byWine = new Map(rows.map((r) => [String(r.wine._id), r]));

    expect(byWine.get(WINE)).toMatchObject({ stock: 2, avgPrice: null });
    expect(byWine.get(OTHER)).toMatchObject({ stock: 2, avgPrice: 250 });
  });
});
