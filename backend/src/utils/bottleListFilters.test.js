/**
 * utils/bottleListFilters — what the cellar views needed so the Statistics
 * charts can deep-link into them (support ticket 2026-09-19): chart NAMES
 * resolved to ids, the producer / size / purchase-year filters /api/bottles
 * already had, and grouping that never merges bottles across cellars.
 */
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn() }));

const Country = require('../models/Country');
const Grape = require('../models/Grape');
const {
  NO_MATCH_ID, normalizeTaxonomyQuery, parseExtraBottleFilters, applyExtraBottleFilters, groupIdenticalBottles,
} = require('./bottleListFilters');

const ID_A = '64b0000000000000000000a1';
const ID_B = '64b0000000000000000000b2';
const distinctOf = (ids) => ({ distinct: jest.fn(async () => ids) });

beforeEach(() => jest.clearAllMocks());

describe('normalizeTaxonomyQuery', () => {
  test('names resolve to ids; ids pass through untouched', async () => {
    Country.find.mockReturnValue(distinctOf([ID_B]));
    const q = { country: `${ID_A},Italy` };
    await normalizeTaxonomyQuery(q);
    expect(Country.find).toHaveBeenCalledWith({ name: { $in: ['Italy'] } });
    expect(q.country).toBe(`${ID_A},${ID_B}`);
  });

  test('all-id params never query the taxonomy', async () => {
    const q = { country: ID_A, grapes: `${ID_A},${ID_B}` };
    await normalizeTaxonomyQuery(q);
    expect(Country.find).not.toHaveBeenCalled();
    expect(Grape.find).not.toHaveBeenCalled();
    expect(q.grapes).toBe(`${ID_A},${ID_B}`);
  });

  test('an unknown name matches NOTHING rather than dropping the filter', async () => {
    Grape.find.mockReturnValue(distinctOf([]));
    const q = { grapes: 'Notagrape' };
    await normalizeTaxonomyQuery(q);
    expect(q.grapes).toBe(NO_MATCH_ID);
  });

  test('non-string params (qs arrays/objects) are left for the route to coerce', async () => {
    const q = { country: ['Italy', 'France'], region: { $ne: 'x' } };
    await normalizeTaxonomyQuery(q);
    expect(q.country).toEqual(['Italy', 'France']);
    expect(Country.find).not.toHaveBeenCalled();
  });
});

describe('parseExtraBottleFilters / applyExtraBottleFilters', () => {
  const b = (over) => ({ _id: Math.random(), bottleSize: '750ml', wineDefinition: { producer: 'Giacomo Conterno' }, ...over });

  test('null when none is set, so hot paths stay available', () => {
    expect(parseExtraBottleFilters({})).toBeNull();
    expect(parseExtraBottleFilters({ producer: '  ', purchaseYear: 'abc' })).toBeNull();
  });

  test('producer is exact and case-insensitive, and regex characters are literal', () => {
    const f = parseExtraBottleFilters({ producer: 'giacomo conterno' });
    const keep = b();
    const partial = b({ wineDefinition: { producer: 'Giacomo Conterno Jr' } });
    expect(applyExtraBottleFilters([keep, partial], f)).toEqual([keep]);

    const dotted = parseExtraBottleFilters({ producer: 'A.B' });
    expect(applyExtraBottleFilters([b({ wineDefinition: { producer: 'AxB' } })], dotted)).toEqual([]);
  });

  test('bottleSize treats a missing size as 750ml; purchaseYear needs a purchase date in that year', () => {
    const size = parseExtraBottleFilters({ bottleSize: '750ml' });
    const unsized = b({ bottleSize: undefined });
    const magnum = b({ bottleSize: '1.5L' });
    expect(applyExtraBottleFilters([unsized, magnum], size)).toEqual([unsized]);

    const year = parseExtraBottleFilters({ purchaseYear: '2023' });
    const in2023 = b({ purchaseDate: new Date(2023, 5, 1) });
    const in2024 = b({ purchaseDate: new Date(2024, 0, 2) });
    const undated = b();
    expect(applyExtraBottleFilters([in2023, in2024, undated], year)).toEqual([in2023]);
  });

  test('an out-of-range year is ignored rather than matching nothing', () => {
    expect(parseExtraBottleFilters({ purchaseYear: '12' })).toBeNull();
  });
});

describe('groupIdenticalBottles', () => {
  const mk = (id, over) => ({ _id: id, cellar: 'c1', vintage: '2019', bottleSize: '750ml', wineDefinition: { _id: 'w1' }, ...over });

  test('same wine + vintage + size collapse, in first-seen order; a magnum stays apart', () => {
    const groups = groupIdenticalBottles([
      mk('1'), mk('2', { vintage: '2020' }), mk('3'), mk('4', { bottleSize: '1.5L' }),
    ]);
    expect(groups.map((g) => g.bottles.map((x) => x._id))).toEqual([['1', '3'], ['2'], ['4']]);
  });

  test('byCellar keeps the same wine in two cellars as two groups', () => {
    const groups = groupIdenticalBottles([mk('1'), mk('2', { cellar: 'c2' }), mk('3')], { byCellar: true });
    expect(groups.map((g) => g.bottles.map((x) => x._id))).toEqual([['1', '3'], ['2']]);
    expect(groupIdenticalBottles([mk('1'), mk('2', { cellar: 'c2' })])).toHaveLength(1);
  });

  test('bottles without a wine are singletons; missing vintage/size group as NV/750ml', () => {
    const groups = groupIdenticalBottles([
      mk('1', { wineDefinition: null }), mk('2', { wineDefinition: null }),
      mk('3', { vintage: '', bottleSize: '' }), mk('4', { vintage: 'NV' }),
    ]);
    expect(groups).toHaveLength(3);
    // '' vintage/size default like the DB grouping path: same group as 'NV'.
    expect(groups[2].bottles.map((x) => x._id)).toEqual(['3', '4']);
  });
});
