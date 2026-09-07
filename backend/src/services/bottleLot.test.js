/**
 * bottleLot — the one definition of "the lot" behind the edit-form checkbox,
 * the bulk bar and update_bottle apply_to_lot (support ticket 2026-09-06).
 * Every consumer mocks this module, so the invariants are pinned here:
 * owned cellars only, consumed excluded, NV folds '' and null, the bottle
 * itself excluded, no wine → no lot, capped at LOT_LIMIT (audit 2026-09-07).
 */
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../config/constants', () => ({ CONSUMED_STATUSES: ['drank', 'gifted', 'sold', 'other'] }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { lotSiblingQuery, findLotSiblingIds, findLotSiblings, pickLotFields, LOT_FIELDS, LOT_LIMIT } = require('./bottleLot');

const chain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => rows);
  c.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return c;
};
const ME = 'u1';

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue(chain([{ _id: 'c1' }, { _id: 'c2' }]));
});

describe('lotSiblingQuery', () => {
  test('same wine and vintage, active, in the user\'s OWN cellars, minus the bottle itself', async () => {
    const q = await lotSiblingQuery(ME, { _id: 'b1', wineDefinition: 'w', vintage: '2019' });
    expect(Cellar.find).toHaveBeenCalledWith({ user: ME, deletedAt: null });
    expect(q).toEqual({
      _id: { $ne: 'b1' },
      cellar: { $in: ['c1', 'c2'] },
      wineDefinition: 'w',
      vintage: '2019',
      status: { $nin: ['drank', 'gifted', 'sold', 'other'] },
    });
  });

  test('a populated wine is reduced to its id; NV matches blank and null vintages too', async () => {
    const q = await lotSiblingQuery(ME, { _id: 'b1', wineDefinition: { _id: 'w' }, vintage: '' });
    expect(q.wineDefinition).toBe('w');
    expect(q.vintage).toEqual({ $in: ['NV', '', null] });
  });

  test('no registry wine, or no owned cellar, means no lot', async () => {
    expect(await lotSiblingQuery(ME, { _id: 'b1', wineDefinition: null, vintage: '2019' })).toBeNull();
    Cellar.find.mockReturnValue(chain([]));
    expect(await lotSiblingQuery(ME, { _id: 'b1', wineDefinition: 'w', vintage: '2019' })).toBeNull();
  });
});

describe('finders', () => {
  test('findLotSiblingIds returns string ids, oldest first, capped at LOT_LIMIT', async () => {
    const c = chain([{ _id: 'x' }, { _id: 'y' }]);
    Bottle.find.mockReturnValue(c);
    const ids = await findLotSiblingIds(ME, { _id: 'b1', wineDefinition: 'w', vintage: '2019' });
    expect(ids).toEqual(['x', 'y']);
    expect(c.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(c.limit).toHaveBeenCalledWith(LOT_LIMIT);
    expect(LOT_LIMIT).toBe(500);
  });

  test('findLotSiblings returns documents (no lean) with the same cap; [] without a lot', async () => {
    const c = chain([{ _id: 'x' }]);
    Bottle.find.mockReturnValue(c);
    const docs = await findLotSiblings(ME, { _id: 'b1', wineDefinition: 'w', vintage: '2019' });
    expect(docs).toEqual([{ _id: 'x' }]);
    expect(c.lean).not.toHaveBeenCalled();
    expect(c.limit).toHaveBeenCalledWith(LOT_LIMIT);
    expect(await findLotSiblings(ME, { _id: 'b1', wineDefinition: null })).toEqual([]);
  });
});

describe('pickLotFields', () => {
  test('keeps only the lot-level fields that were actually sent', () => {
    expect(LOT_FIELDS).toEqual(['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'price', 'currency']);
    expect(pickLotFields({ drinkFrom: 2026, notes: 'x', price: undefined, currency: 'SEK', peakUntil: null }))
      .toEqual({ drinkFrom: 2026, currency: 'SEK', peakUntil: null });
  });
});
