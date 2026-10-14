/**
 * A member's own quarantined drinks (2026-10-13): a search finds the hidden
 * rows the caller created or holds a bottle of, and nobody else's.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { findOwnHiddenWineIds, isOwnHiddenWine } = require('./ownHiddenWines');

const ME = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const W1 = '64b0000000000000000000a1';
const W2 = '64b0000000000000000000a2';
const W3 = '64b0000000000000000000a3';
const C1 = '64b0000000000000000000c1'; // the caller's own cellar
const C2 = '64b0000000000000000000c2'; // a cellar shared with the caller

const findReturning = (rows) => {
  const q = { select: jest.fn(() => q), limit: jest.fn(() => q), lean: jest.fn().mockResolvedValue(rows) };
  WineDefinition.find.mockReturnValue(q);
  return q;
};
// The caller's cellars: own + shared with them (owner or member), not deleted.
const cellarsReturning = (ids) => Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue(ids) });
const MEMBER_FILTER = { $or: [{ user: ME }, { 'members.user': ME }], deletedAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  cellarsReturning([C1, C2]);
});

describe('findOwnHiddenWineIds', () => {
  test('looks only among quarantined rows, every word of the search in the wine key', async () => {
    findReturning([]);
    await findOwnHiddenWineIds(ME, 'Example Brewery 1664');
    expect(WineDefinition.find).toHaveBeenCalledWith({
      nonWine: true,
      canary: { $ne: true },
      $and: [{ normalizedKey: { $regex: 'example' } }, { normalizedKey: { $regex: 'brewery' } }, { normalizedKey: { $regex: '1664' } }],
    });
  });

  test('words are normalized like the key: case, accents and punctuation fold away', async () => {
    findReturning([]);
    await findOwnHiddenWineIds(ME, 'Ébène  CIDRE!');
    expect(WineDefinition.find.mock.calls[0][0].$and).toEqual([
      { normalizedKey: { $regex: 'ebene' } }, { normalizedKey: { $regex: 'cidre' } },
    ]);
  });

  test('returns the rows the caller created or holds a bottle of — never anyone else\'s', async () => {
    findReturning([
      { _id: W1, createdBy: ME }, // created, no bottle left
      { _id: W2, createdBy: OTHER }, // someone else's, but the caller holds a bottle
      { _id: W3, createdBy: OTHER }, // someone else's, not held
    ]);
    Bottle.distinct.mockResolvedValue([W2]);

    const ids = await findOwnHiddenWineIds(ME, 'soda');
    expect(ids.sort()).toEqual([W1, W2].sort());
    // Held = any bottle status in any cellar of the caller's — own or shared
    // with them (a bottle's `user` is the cellar OWNER, so an editor who
    // added the cider must still find it — audit 2026-10-14): a drunk bottle
    // is the "buy it again" case.
    expect(Cellar.find).toHaveBeenCalledWith(MEMBER_FILTER);
    expect(Bottle.distinct).toHaveBeenCalledWith('wineDefinition', { cellar: { $in: [C1, C2] }, wineDefinition: { $in: [W1, W2, W3] } });
  });

  test('a caller with no cellar at all gets only the rows they created, with no bottle lookup', async () => {
    cellarsReturning([]);
    findReturning([{ _id: W1, createdBy: ME }, { _id: W2, createdBy: OTHER }]);
    expect(await findOwnHiddenWineIds(ME, 'soda')).toEqual([W1]);
    expect(Bottle.distinct).not.toHaveBeenCalled();
  });

  test('a row both created and held appears once; the limit applies', async () => {
    findReturning([{ _id: W1, createdBy: ME }, { _id: W2, createdBy: ME }]);
    Bottle.distinct.mockResolvedValue([W1, W2]);
    expect(await findOwnHiddenWineIds(ME, 'x', { limit: 5 })).toEqual([W1, W2]);
    findReturning([{ _id: W1, createdBy: ME }, { _id: W2, createdBy: ME }]);
    expect(await findOwnHiddenWineIds(ME, 'x', { limit: 1 })).toEqual([W1]);
  });

  test('no caller, or a search with no words, asks nothing', async () => {
    expect(await findOwnHiddenWineIds(null, 'bud')).toEqual([]);
    expect(await findOwnHiddenWineIds(ME, ' !? ')).toEqual([]);
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });

  test('no quarantined match → no bottle lookup', async () => {
    findReturning([]);
    expect(await findOwnHiddenWineIds(ME, 'barolo')).toEqual([]);
    expect(Bottle.distinct).not.toHaveBeenCalled();
  });
});

describe('isOwnHiddenWine', () => {
  const findOneReturning = (doc) => {
    const q = { select: jest.fn(() => q), lean: jest.fn().mockResolvedValue(doc) };
    WineDefinition.findOne.mockReturnValue(q);
  };

  test('a quarantined row the caller created', async () => {
    findOneReturning({ _id: W1, createdBy: ME });
    expect(await isOwnHiddenWine(ME, W1)).toBe(true);
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ _id: W1, nonWine: true });
    expect(Bottle.exists).not.toHaveBeenCalled();
  });

  test('a quarantined row the caller holds a bottle of — in their own cellar or one shared with them', async () => {
    findOneReturning({ _id: W1, createdBy: OTHER });
    Bottle.exists.mockResolvedValue({ _id: 'b1' });
    expect(await isOwnHiddenWine(ME, W1)).toBe(true);
    expect(Cellar.find).toHaveBeenCalledWith(MEMBER_FILTER);
    expect(Bottle.exists).toHaveBeenCalledWith({ cellar: { $in: [C1, C2] }, wineDefinition: W1 });
  });

  test('someone else\'s quarantined row, or a row that is not quarantined', async () => {
    findOneReturning({ _id: W1, createdBy: OTHER });
    Bottle.exists.mockResolvedValue(null);
    expect(await isOwnHiddenWine(ME, W1)).toBe(false);
    findOneReturning(null);
    expect(await isOwnHiddenWine(ME, W1)).toBe(false);
  });

  test('no cellar at all → not held, and no bottle lookup', async () => {
    cellarsReturning([]);
    findOneReturning({ _id: W1, createdBy: OTHER });
    expect(await isOwnHiddenWine(ME, W1)).toBe(false);
    expect(Bottle.exists).not.toHaveBeenCalled();
  });
});
