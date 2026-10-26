/**
 * The Other category on a member's word (services/nonWineOps).
 *
 * A member who holds a bottle of a record moves it out of the shared wine
 * registry: at once while few members hold it (the sommelier's direct-apply
 * rule), as a curator proposal when many do. Nobody else can, a draft is not
 * a registry row, and a row already in Other says so. Models, search and the
 * holder count are mocked: the decisions are under test, not MongoDB.
 */
jest.mock('../models/Bottle', () => ({ exists: jest.fn() }));
jest.mock('../models/Cellar', () => ({ distinct: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) }));
jest.mock('../models/WineVintageProfile', () => ({ deleteMany: jest.fn().mockResolvedValue({ deletedCount: 2 }) }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn() }));
jest.mock('./search', () => ({ indexWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./proposalDirectApply', () => ({ countHoldingMembers: jest.fn(), NON_WINE_DIRECT_MAX_OWNERS: 3 }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const searchService = require('./search');
const { logAudit } = require('./audit');
const { countHoldingMembers } = require('./proposalDirectApply');
const { markNotWineByMember, quarantineAsNonWine } = require('./nonWineOps');

const USER = '64b000000000000000000001';
const OTHER_USER = '64b000000000000000000002';
const WINE_ID = '64b0000000000000000000c1';

const cider = (over = {}) => {
  const w = { _id: WINE_ID, name: 'Vintage Cider', producer: 'Example Orchard', type: 'sparkling', nonWine: false, createdBy: OTHER_USER, ...over };
  w.save = jest.fn().mockResolvedValue(w);
  return w;
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.distinct.mockResolvedValue(['cellar-1']);
  Bottle.exists.mockResolvedValue(true);
  WineVintageProfile.deleteMany.mockResolvedValue({ deletedCount: 2 });
});

describe('markNotWineByMember', () => {
  test('applies at once while few members hold the row, completing the quarantine', async () => {
    const w = cider();
    WineDefinition.findById.mockResolvedValue(w);
    countHoldingMembers.mockResolvedValue(2);

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER, via: 'member' });

    expect(r).toMatchObject({ ok: true, status: 'applied', category: 'other', holders: 2, pendingRemoved: 2 });
    expect(w.nonWine).toBe(true);
    expect(w.save).toHaveBeenCalledTimes(1);
    expect(searchService.indexWine).toHaveBeenCalledWith(WINE_ID);
    expect(WineEmbedding.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
    expect(WineVintageProfile.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID, status: 'pending' });
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.nonWine', { type: 'wine', id: WINE_ID }, expect.objectContaining({ value: true, via: 'member', pendingRemoved: 2 }));
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('files the curator proposal instead when many members hold the row', async () => {
    const w = cider();
    WineDefinition.findById.mockResolvedValue(w);
    countHoldingMembers.mockResolvedValue(7);
    WineCorrectionProposal.create.mockResolvedValue({ _id: 'p1' });

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER });

    expect(r).toMatchObject({ ok: true, status: 'filed', category: 'wine', holders: 7 });
    expect(w.nonWine).toBe(false);
    expect(w.save).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      proposer: USER, wineDefinition: WINE_ID, kind: 'non_wine',
      currentSnapshot: expect.objectContaining({ name: 'Vintage Cider', producer: 'Example Orchard', type: 'sparkling' }),
    }));
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.nonWineProposed', { type: 'wine', id: WINE_ID }, expect.objectContaining({ holders: 7 }));
  });

  test('a proposal already waiting is reported as pending, not as an error', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    countHoldingMembers.mockResolvedValue(5);
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER });
    expect(r).toMatchObject({ ok: true, status: 'pending', category: 'wine' });
  });

  test('a member holding no bottle of it is refused; the creator always may', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    Bottle.exists.mockResolvedValue(false);
    countHoldingMembers.mockResolvedValue(1);

    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toMatchObject({ ok: false, code: 'forbidden' });

    WineDefinition.findById.mockResolvedValue(cider({ createdBy: USER }));
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toMatchObject({ ok: true, status: 'applied' });
  });

  test('a row already in Other, a draft, a missing row and a bad id', async () => {
    WineDefinition.findById.mockResolvedValue(cider({ nonWine: true }));
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toEqual({ ok: true, status: 'already', category: 'other' });

    WineDefinition.findById.mockResolvedValue(cider({ draft: true }));
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toMatchObject({ ok: false, code: 'not_found' });

    WineDefinition.findById.mockResolvedValue(null);
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toMatchObject({ ok: false, code: 'not_found' });

    expect(await markNotWineByMember({ wineId: 'nope', userId: USER })).toMatchObject({ ok: false, code: 'invalid' });
    expect(countHoldingMembers).not.toHaveBeenCalled();
  });
});

describe('quarantineAsNonWine', () => {
  test('a row already flagged is not saved again and loses no reviewed windows', async () => {
    const w = cider({ nonWine: true });
    const r = await quarantineAsNonWine(w, { via: 'admin' });
    expect(r).toEqual({ alreadyFlagged: true, pendingRemoved: 0 });
    expect(w.save).not.toHaveBeenCalled();
    expect(WineVintageProfile.deleteMany).not.toHaveBeenCalled();
    expect(WineEmbedding.deleteMany).toHaveBeenCalledTimes(1);
  });
});
