/**
 * The Other category on a member's word (services/nonWineOps).
 *
 * A member who holds a bottle of a record, in a cellar they can edit, moves it
 * out of the shared wine registry: the non_wine proposal is filed and applied
 * at once when the direct-apply rule allows (few holders), or left for a
 * curator when many hold it. A viewer cannot, a draft is not a registry row,
 * and a row already in Other says so. Models, the rule and the apply are
 * mocked: the decisions are under test, not MongoDB.
 */
jest.mock('../models/Bottle', () => ({ exists: jest.fn(), distinct: jest.fn(async () => []) }));
jest.mock('../models/Cellar', () => ({ distinct: jest.fn(), find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./proposalDirectApply', () => ({ classifyProposal: jest.fn(), countHoldingMembers: jest.fn() }));
jest.mock('../routes/admin/wineProposals', () => ({ approveProposal: jest.fn() }));
jest.mock('./contributionGate', () => ({ checkContributionGate: jest.fn(async () => ({ ok: true, user: {} })) }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(async () => null) }));
jest.mock('./dataVersion', () => ({ bumpWineOwners: jest.fn(async () => undefined) }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { logAudit } = require('./audit');
const { classifyProposal, countHoldingMembers } = require('./proposalDirectApply');
const { approveProposal } = require('../routes/admin/wineProposals');
const { checkContributionGate } = require('./contributionGate');
const { createNotification } = require('./notifications');
const { bumpWineOwners } = require('./dataVersion');
const { markNotWineByMember, applyOtherCategoryAfterAdd, holdsBottleOf } = require('./nonWineOps');

const USER = '64b000000000000000000001';
const OTHER_USER = '64b000000000000000000002';
const WINE_ID = '64b0000000000000000000c1';
const PROPOSAL_ID = '64b0000000000000000000d1';

const cider = (over = {}) => ({ _id: WINE_ID, name: 'Vintage Cider', producer: 'Example Orchard', type: 'sparkling', nonWine: false, createdBy: OTHER_USER, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.distinct.mockResolvedValue(['cellar-1']);
  Bottle.exists.mockResolvedValue(true);
  WineCorrectionProposal.create.mockResolvedValue({ _id: PROPOSAL_ID });
  classifyProposal.mockResolvedValue({ direct: true, reason: 'few holders' });
  approveProposal.mockResolvedValue({ status: 200, body: { appliedNote: 'Quarantined as non-wine' } });
  countHoldingMembers.mockResolvedValue(7);
});

describe('markNotWineByMember', () => {
  test('files the proposal and applies it at once when the direct-apply rule allows', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    const req = { user: { id: USER } };

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER, req, via: 'member' });

    expect(r).toEqual({ ok: true, status: 'applied', category: 'other' });
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      proposer: USER, wineDefinition: WINE_ID, kind: 'non_wine',
      currentSnapshot: expect.objectContaining({ name: 'Vintage Cider', producer: 'Example Orchard', type: 'sparkling' }),
    }));
    expect(classifyProposal).toHaveBeenCalledWith(expect.objectContaining({ _id: WINE_ID }), 'non_wine', null);
    expect(approveProposal).toHaveBeenCalledWith(PROPOSAL_ID, req);
    expect(logAudit).toHaveBeenCalledWith(req, 'wine.nonWineProposed', { type: 'wine', id: WINE_ID }, expect.objectContaining({ via: 'member' }));
  });

  test('a request-less caller gets a stand-in req for decidedBy', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    await markNotWineByMember({ wineId: WINE_ID, userId: USER, via: 'mcp' });
    expect(approveProposal).toHaveBeenCalledWith(PROPOSAL_ID, { user: { id: USER } });
  });

  test('leaves the proposal for a curator when many members hold the row', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    classifyProposal.mockResolvedValue({ direct: false, reason: '7 members hold bottles of this wine' });

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER });

    expect(r).toEqual({ ok: true, status: 'filed', category: 'wine', holders: 7 });
    expect(WineCorrectionProposal.create).toHaveBeenCalledTimes(1);
    expect(approveProposal).not.toHaveBeenCalled();
  });

  test('a declined self-apply reads as filed, never as applied', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    approveProposal.mockResolvedValue({ status: 409, body: { error: 'claimed' } });
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toEqual({ ok: true, status: 'filed', category: 'wine' });
  });

  test('a proposal already waiting is reported as pending, not as an error', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toEqual({ ok: true, status: 'pending', category: 'wine' });
    expect(approveProposal).not.toHaveBeenCalled();
  });

  test('a member holding no bottle of it is refused; the creator always may', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    Bottle.exists.mockResolvedValue(false);
    expect(await markNotWineByMember({ wineId: WINE_ID, userId: USER })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();

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
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});

describe('holdsBottleOf', () => {
  test('counts the owner and editors of a cellar, never a viewer', async () => {
    await holdsBottleOf(USER, WINE_ID);
    expect(Cellar.distinct).toHaveBeenCalledWith('_id', {
      deletedAt: null,
      $or: [{ user: USER }, { members: { $elemMatch: { user: USER, role: 'editor' } } }],
    });
    expect(Bottle.exists).toHaveBeenCalledWith({ wineDefinition: WINE_ID, cellar: { $in: ['cellar-1'] } });
  });

  test('no editable cellar means no bottle, without a bottle query', async () => {
    Cellar.distinct.mockResolvedValue([]);
    expect(await holdsBottleOf(USER, WINE_ID)).toBe(false);
    expect(Bottle.exists).not.toHaveBeenCalled();
  });
});

describe('applyOtherCategoryAfterAdd', () => {
  test('an "other" add that matched a registry wine moves it like the bottle page would', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    const r = await applyOtherCategoryAfterAdd({ wine: cider(), newWine: { category: 'other' }, userId: USER, via: 'add' });
    expect(r).toEqual({ status: 'applied', category: 'other' });
    expect(approveProposal).toHaveBeenCalled();
  });

  test('nothing to do for a wine add, or when the matched row is already Other', async () => {
    expect(await applyOtherCategoryAfterAdd({ wine: cider(), newWine: { category: 'wine' }, userId: USER })).toBeNull();
    expect(await applyOtherCategoryAfterAdd({ wine: cider({ nonWine: true }), newWine: { category: 'other' }, userId: USER })).toBeNull();
    expect(await applyOtherCategoryAfterAdd({ wine: cider(), newWine: undefined, userId: USER })).toBeNull();
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});

// Release audit 2026-10-28: the move pays the contribution gate like every
// other member write to the registry, and the other holders are told.
describe('markNotWineByMember — gate and co-holders', () => {
  test('a banned member is refused before anything is filed; a move from the bottle page spends the daily budget', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    checkContributionGate.mockResolvedValueOnce({ ok: false, code: 'banned', message: 'You are banned from posting content visible to other users' });

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER, via: 'member' });

    expect(r).toMatchObject({ ok: false, code: 'banned' });
    expect(checkContributionGate).toHaveBeenCalledWith(USER, { budget: true });
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('a drink added as Other up front pays the ban check only, never the budget', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    await applyOtherCategoryAfterAdd({ wine: cider(), newWine: { category: 'other' }, userId: USER });
    expect(checkContributionGate).toHaveBeenCalledWith(USER, { budget: false });
  });

  test('an applied move tells the other holders, never the mover, and bumps the holders\' caches', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    Bottle.distinct.mockResolvedValueOnce(['cellar-1', 'cellar-2']);
    Cellar.find.mockReturnValueOnce({ select: () => ({ lean: async () => [
      { user: USER, members: [{ user: OTHER_USER }] },
      { user: '64b000000000000000000003', members: [] },
    ] }) });

    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER, via: 'member' });

    expect(r).toEqual({ ok: true, status: 'applied', category: 'other' });
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith(OTHER_USER, 'wine_moved_to_other', expect.any(String), expect.stringContaining('Vintage Cider'));
    expect(createNotification).toHaveBeenCalledWith('64b000000000000000000003', 'wine_moved_to_other', expect.any(String), expect.any(String));
    expect(createNotification).not.toHaveBeenCalledWith(USER, expect.anything(), expect.anything(), expect.anything());
    expect(bumpWineOwners).toHaveBeenCalledWith([WINE_ID]);
  });

  test('a filed move (many holders) notifies nobody yet', async () => {
    WineDefinition.findById.mockResolvedValue(cider());
    classifyProposal.mockResolvedValueOnce({ direct: false, reason: 'many holders' });
    const r = await markNotWineByMember({ wineId: WINE_ID, userId: USER, via: 'member' });
    expect(r.status).toBe('filed');
    expect(createNotification).not.toHaveBeenCalled();
    expect(bumpWineOwners).not.toHaveBeenCalled();
  });
});
