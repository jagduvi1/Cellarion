/**
 * MCP Phase-3 insight tools — cellar_health_check / find_gaps / value_report /
 * case_journey invariants.
 *
 * Pins: scope + honest annotations, owned-cellar scoping, the derived analysis
 * (type balance, blind spots, gainers-exclude-paid, at-risk classification,
 * lot grouping + pace verdicts), the per-user TTL cache, and that empty cellars
 * return clean envelopes rather than errors. Personal drink windows are used in
 * fixtures so maturity classification runs REAL code without profile fixtures.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/CellarValueSnapshot', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn(() => ({ overview: {} })) }));
jest.mock('../services/valuation', () => ({ resolveReplacementForBottles: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(async () => ({ rates: {} })),
  convertCurrency: jest.fn((amount) => amount), // 1:1 world — currency math is unit-tested elsewhere
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const WishlistItem = require('../models/WishlistItem');
const WineVintageProfile = require('../models/WineVintageProfile');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const statsService = require('../services/statsService');
const valuation = require('../services/valuation');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const ctxFor = (id) => ({ user: { id }, scopes: ['read'] });

const THIS_YEAR = new Date().getFullYear();

// Canned computeOverview payload with only the fields the tools read.
const STATS = {
  overview: { totalValue: 1234.5, healthScore: 78, healthGrade: 'B', regretIndex: 10 },
  byType: { red: 30, white: 2 },
  consumedByType: { red: 3, sparkling: 8 },
  byVintage: [{ year: '1998', count: 1 }, { year: '2019', count: 3 }, { year: 'NV', count: 2 }],
  byCountry: [{ name: 'France', count: 20, code: 'FR' }],
  allRegions: [{ name: 'Rioja', count: 12 }],
  allGrapes: [{ name: 'Tempranillo', count: 12 }],
  allProducers: [{ name: 'Muga', count: 6 }],
  maturity: { declining: 2, late: 1, peak: 5, early: 3, notReady: 1, noProfile: 20 },
  maturityCoverage: { sommSet: 12, none: 20 },
  urgencyLadder: [{ id: 'x', name: 'Old Rioja', vintage: '2001', status: 'declining', price: 50 }],
  pace: { avgIntakePerYear: 24, avgOutputPerYear: 12, netPerYear: 12, runway: 8 },
  maturityForecast: Array.from({ length: 11 }, (_, i) => ({ year: THIS_YEAR + i, count: i })),
};

const mkBottle = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  cellar: oid('c'),
  vintage: '2015',
  status: 'active',
  wineDefinition: { _id: new mongoose.Types.ObjectId(), name: 'Wine', producer: 'P', type: 'red' },
  ...over,
});

/** Wire one loadPortfolio round: user prefs, cellars, active + consumed. */
function wirePortfolio({ active = [], consumed = [], cellars } = {}) {
  User.findById.mockReturnValue(chain({ preferences: { currency: 'EUR', ratingScale: '5' } }));
  Cellar.find.mockReturnValue(chain(cellars ?? [{ _id: new mongoose.Types.ObjectId(oid('c')), name: 'Main' }]));
  Bottle.find
    .mockReturnValueOnce(chain(active))
    .mockReturnValueOnce(chain(consumed));
  WineVintageProfile.find.mockReturnValue(chain([]));
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): wirePortfolio queues mockReturnValueOnce
  // values, and a test that short-circuits before consuming them (empty cellars,
  // cache hits) must not leak its queue into the next test. It also wipes
  // factory implementations, so everything is re-primed here.
  jest.resetAllMocks();
  statsService.computeOverview.mockResolvedValue(STATS);
  valuation.resolveReplacementForBottles.mockResolvedValue(new Map());
  CellarValueSnapshot.find.mockReturnValue(chain([]));
  WishlistItem.find.mockReturnValue(chain([]));
  const fx = require('../utils/exchangeRates');
  fx.getOrCreateDailySnapshot.mockResolvedValue({ rates: {} });
  fx.convertCurrency.mockImplementation((amount) => amount);
});

describe('registration', () => {
  test('all four are read-scoped with read-only annotations', () => {
    for (const name of ['cellar_health_check', 'find_gaps', 'value_report', 'case_journey']) {
      expect(tool(name).scope).toBe('read');
      expect(tool(name).annotations.readOnlyHint).toBe(true);
    }
  });
});

describe('cellar_health_check', () => {
  test('empty account → clean empty envelope, no diagnosis', async () => {
    wirePortfolio({ cellars: [] });
    const res = await tool('cellar_health_check').handler({}, ctxFor(oid('1')));
    expect(parse(res).data.empty).toBe(true);
  });

  test('type balance: never-drunk types flagged, surplus years derived from 5y window', async () => {
    const recent = new Date();
    const active = [mkBottle(), mkBottle()];
    const consumed = [
      mkBottle({ status: 'drank', consumedAt: recent, wineDefinition: { _id: new mongoose.Types.ObjectId(), type: 'red', name: 'R' } }),
    ];
    wirePortfolio({ active, consumed });
    const res = await tool('cellar_health_check').handler({}, ctxFor(oid('2')));
    const { data } = parse(res);
    const red = data.type_balance.find((t) => t.type === 'red');
    expect(red.active).toBe(30);              // from stats byType
    expect(red.consumed_per_year).toBe(0.2);  // 1 consumed / 5y window
    expect(red.surplus_years).toBe(150);      // 30 / 0.2
    const white = data.type_balance.find((t) => t.type === 'white');
    expect(white.never_drunk_recently).toBe(true);
    expect(data.pace).toEqual(STATS.pace);
    expect(data.urgent).toEqual(STATS.urgencyLadder);
    expect(data.windows_opening).toHaveLength(6);
  });

  test('aging blind spots: old vintages with no window classification, oldest first', async () => {
    const blind1 = mkBottle({ vintage: String(THIS_YEAR - 10) });
    const blind2 = mkBottle({ vintage: String(THIS_YEAR - 20) });
    const young = mkBottle({ vintage: String(THIS_YEAR - 1) });          // too young to be a blind spot
    const windowed = mkBottle({ vintage: String(THIS_YEAR - 10), drinkTo: THIS_YEAR + 2 }); // has a personal window
    wirePortfolio({ active: [blind1, blind2, young, windowed], consumed: [] });
    const res = await tool('cellar_health_check').handler({}, ctxFor(oid('3')));
    const { data } = parse(res);
    expect(data.aging_blind_spots.count).toBe(2);
    expect(data.aging_blind_spots.oldest[0].vintage).toBe(String(THIS_YEAR - 20));
  });

  test('result is cached per user for the TTL (no recompute on repeat)', async () => {
    wirePortfolio({ active: [mkBottle()], consumed: [] });
    await tool('cellar_health_check').handler({}, ctxFor(oid('4')));
    Cellar.find.mockClear();
    Bottle.find.mockClear();
    await tool('cellar_health_check').handler({}, ctxFor(oid('4')));
    expect(Cellar.find).not.toHaveBeenCalled();
    expect(Bottle.find).not.toHaveBeenCalled();
  });
});

describe('find_gaps', () => {
  test('zero-count canonical styles are listed as missing; consumed-only types still appear', async () => {
    wirePortfolio({ active: [mkBottle()], consumed: [] });
    const res = await tool('find_gaps').handler({}, ctxFor(oid('5')));
    const { data } = parse(res);
    // STATS has red+white active; sparkling consumed only; rosé/dessert/fortified absent.
    expect(data.styles_missing).toEqual(expect.arrayContaining(['rosé', 'sparkling', 'dessert', 'fortified']));
    const sparkling = data.by_type.find((t) => t.type === 'sparkling');
    expect(sparkling).toMatchObject({ active: 0, consumed_all_time: 8 }); // drinks-vs-holds gap signal
    expect(data.vintage_decades).toEqual(expect.arrayContaining([
      { decade: '1990s', count: 1 }, { decade: '2010s', count: 3 }, { decade: 'NV', count: 2 },
    ]));
  });

  test('price bands classify converted prices; unpriced counted separately', async () => {
    const active = [
      mkBottle({ price: 10, currency: 'EUR' }),   // budget
      mkBottle({ price: 30, currency: 'EUR' }),   // mid
      mkBottle({ price: 90, currency: 'EUR' }),   // premium
      mkBottle({ price: 500, currency: 'EUR' }),  // luxury
      mkBottle(),                                  // unpriced
    ];
    wirePortfolio({ active, consumed: [] });
    const res = await tool('find_gaps').handler({}, ctxFor(oid('6')));
    const { data } = parse(res);
    expect(data.price_bands).toMatchObject({ budget: 1, mid: 1, premium: 1, luxury: 1, unpriced: 1 });
  });

  test('price bands report unavailable (not all-luxury) when edge conversion fails', async () => {
    const fx = require('../utils/exchangeRates');
    // Rates missing: cross-currency conversion nulls, same-currency passes.
    fx.convertCurrency.mockImplementation((amount, from, to) => (from === to ? amount : null));
    // Target USD (prefs) with EUR band edges → edges null → bands must degrade honestly.
    const User = require('../models/User');
    wirePortfolio({ active: [mkBottle({ price: 500, currency: 'USD' })], consumed: [] });
    User.findById.mockReturnValue(chain({ preferences: { currency: 'USD' } }));
    const res = await tool('find_gaps').handler({}, ctxFor(oid('b')));
    const { data } = parse(res);
    expect(data.price_bands.unavailable).toBe(true);
    expect(data.price_bands.luxury).toBeUndefined();
  });

  test('wishlist items ride along for cross-referencing gaps', async () => {
    wirePortfolio({ active: [mkBottle()], consumed: [] });
    WishlistItem.find.mockReturnValue(chain([
      { wineDefinition: { name: 'Champagne X', producer: 'H', type: 'sparkling' }, vintage: null },
    ]));
    const res = await tool('find_gaps').handler({}, ctxFor(oid('7')));
    const { data } = parse(res);
    expect(data.wishlist.wanted).toBe(1);
    expect(data.wishlist.items[0].type).toBe('sparkling');
  });
});

describe('value_report', () => {
  test('gainers exclude paid-source estimates; unrealized gain = est − cost', async () => {
    const b1 = mkBottle({ price: 100, currency: 'EUR' }); // market-priced: gain
    const b2 = mkBottle({ price: 50, currency: 'EUR' });  // paid-source: no gain row
    wirePortfolio({ active: [b1, b2], consumed: [] });
    valuation.resolveReplacementForBottles.mockResolvedValue(new Map([
      [String(b1._id), { amount: 300, currency: 'EUR', source: 'secondary' }],
      [String(b2._id), { amount: 50, currency: 'EUR', source: 'paid' }],
    ]));
    const res = await tool('value_report').handler({}, ctxFor(oid('8')));
    const { data } = parse(res);
    expect(data.cost_basis.total).toBe(150);
    expect(data.replacement.total).toBe(350);
    expect(data.unrealized_gain).toBe(200);
    expect(data.top_gainers).toHaveLength(1);
    expect(data.top_gainers[0]).toMatchObject({ cost: 100, estimated: 300, gain: 200, gain_pct: 200, source: 'secondary' });
    expect(data.replacement.by_source).toMatchObject({ secondary: 1, paid: 1 });
  });

  test('value_at_risk collects declining/late bottles (personal window past)', async () => {
    const risky = mkBottle({ price: 80, currency: 'EUR', drinkTo: THIS_YEAR - 1 }); // declining by personal window
    const fine = mkBottle({ price: 80, currency: 'EUR', drinkTo: THIS_YEAR + 5 });
    wirePortfolio({ active: [risky, fine], consumed: [] });
    const res = await tool('value_report').handler({}, ctxFor(oid('9')));
    const { data } = parse(res);
    expect(data.value_at_risk.total).toBe(80);
    expect(data.value_at_risk.bottles).toHaveLength(1);
    expect(data.value_at_risk.bottles[0].status).toBe('declining');
  });

  test('trend condenses the year of snapshots to first/latest sums', async () => {
    wirePortfolio({ active: [mkBottle({ price: 10, currency: 'EUR' })], consumed: [] });
    CellarValueSnapshot.find.mockReturnValue(chain([
      { date: '2026-01-03', totalValue: 100, replacementValue: 120 },
      { date: '2026-01-03', totalValue: 50, replacementValue: 60 },  // second cellar, same day
      { date: '2026-07-01', totalValue: 200, replacementValue: 260 },
    ]));
    const res = await tool('value_report').handler({}, ctxFor(oid('e')));
    const { data } = parse(res);
    expect(data.trend).toMatchObject({
      from_date: '2026-01-03', to_date: '2026-07-01',
      cost_basis_from: 150, cost_basis_to: 200, replacement_from: 180, replacement_to: 260,
    });
  });
});

describe('case_journey', () => {
  const wine = { _id: new mongoose.Types.ObjectId(), name: 'Léoville', producer: 'B', type: 'red' };
  const lotBottle = (over = {}) => mkBottle({ wineDefinition: wine, vintage: '2016', ...over });

  test('groups by wine+vintage, reports counts, events and a pace verdict', async () => {
    const consumedA = lotBottle({
      status: 'drank', consumedAt: new Date(Date.now() - 2 * 365.25 * 86400000),
      consumedReason: 'drank', consumedRating: 3, consumedRatingScale: '5', consumedNote: 'young still',
    });
    const consumedB = lotBottle({
      status: 'drank', consumedAt: new Date(Date.now() - 30 * 86400000),
      consumedReason: 'drank', consumedRating: 5, consumedRatingScale: '5',
    });
    const remaining = lotBottle({ drinkTo: THIS_YEAR + 10 });
    const stray = mkBottle(); // different wine — below min_count, dropped
    Cellar.find.mockReturnValue(chain([{ _id: new mongoose.Types.ObjectId(oid('c')), name: 'Main' }]));
    Bottle.find.mockReturnValue(chain([consumedA, consumedB, remaining, stray]));
    WineVintageProfile.find.mockReturnValue(chain([]));

    const res = await tool('case_journey').handler({ min_count: 3 }, ctxFor(oid('f')));
    const { data } = parse(res);
    expect(data).toHaveLength(1);
    const lot = data[0];
    expect(lot.counts).toEqual({ total: 3, remaining: 1, consumed: 2 });
    expect(lot.consumed_events).toHaveLength(2);
    expect(lot.consumed_events[0].note).toBe('young still'); // chronological order
    expect(lot.rating_trend.direction).toBe('improving');    // 3★ → 5★
    expect(lot.pace.verdict).toBe('on_track');               // 1/yr, 1 left, window +10y
  });

  test('focus by bottle_id narrows to that lot even below min_count', async () => {
    const b = lotBottle();
    Bottle.findById.mockReturnValue(chain(b));
    Cellar.findById.mockReturnValue(chain({ _id: new mongoose.Types.ObjectId(oid('c')), user: oid('a'), members: [], deletedAt: null }));
    Cellar.find.mockReturnValue(chain([{ _id: new mongoose.Types.ObjectId(oid('c')), name: 'Main' }]));
    Bottle.find.mockReturnValue(chain([b]));
    WineVintageProfile.find.mockReturnValue(chain([]));
    const res = await tool('case_journey').handler({ bottle_id: String(b._id) }, { user: { id: oid('a') }, scopes: ['read'] });
    const { data } = parse(res);
    expect(data).toHaveLength(1);
    expect(data[0].counts.total).toBe(1);
  });

  test('foreign bottle focus → not_found (no existence oracle)', async () => {
    Bottle.findById.mockReturnValue(chain(null));
    const res = await tool('case_journey').handler({ bottle_id: oid('d') }, ctxFor(oid('a')));
    expect(parse(res).error.code).toBe('not_found');
  });
});
