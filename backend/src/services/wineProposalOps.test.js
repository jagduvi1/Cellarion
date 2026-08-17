/**
 * wineProposalOps (#985 Slice A) — the shared user-suggestion engine both the
 * REST route and the MCP tool suggest_wine_correction call.
 *
 * Pins: validation (reason bounds, URL shape, field whitelist, at-least-one),
 * the discussion ban, the per-tier daily budget, wine VISIBILITY (not
 * ownership) gating, the snapshot shape the admin diff depends on, the
 * E11000 → friendly conflict mapping, and the caller-scoped mine listing.
 */

jest.mock('../models/WineCorrectionProposal', () => ({
  create: jest.fn(), countDocuments: jest.fn(), find: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const User = require('../models/User');
const { findVisibleWine } = require('./wineVisibility');
const { logAudit } = require('./audit');
const ops = require('./wineProposalOps');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');

const wineDoc = {
  _id: WINE,
  producer: 'Cloudy Bay',
  name: 'Sauvignon Blanc',
  appellation: null,
  classification: null,
  region: { name: 'Marlborough' },
  country: { name: 'New Zealand' },
};

const mockUser = (tier = 'newcomer', banned = false) =>
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      contribution: { tier },
      isDiscussionBanned: () => banned,
      username: 'johan',
    }),
  });

const GOOD = {
  wineId: WINE,
  fields: { appellation: 'Marlborough GI' },
  reason: 'Printed on the back label of my bottle.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser();
  WineCorrectionProposal.countDocuments.mockResolvedValue(0);
  findVisibleWine.mockResolvedValue(wineDoc);
  WineCorrectionProposal.create.mockResolvedValue({ _id: oid('9'), proposedFields: GOOD.fields, status: 'pending' });
});

describe('createFieldCorrection validation', () => {
  test('reason too short / too long', async () => {
    expect((await ops.createFieldCorrection(ME, { ...GOOD, reason: 'short' })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, reason: 'x'.repeat(1001) })).code).toBe('invalid');
  });

  test('HTML is stripped from the reason before length-checking', async () => {
    const res = await ops.createFieldCorrection(ME, { ...GOOD, reason: '<b></b><i></i>hey' });
    expect(res.code).toBe('invalid'); // 3 chars of real text left
  });

  test('bad evidence URL rejected; unknown field rejected; empty fields rejected', async () => {
    expect((await ops.createFieldCorrection(ME, { ...GOOD, evidenceUrl: 'ftp://x' })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { vintage: '2019' } })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { producer: '   ' } })).code).toBe('invalid');
  });

  test('discussion ban blocks the write before any query', async () => {
    mockUser('newcomer', true);
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res.code).toBe('banned');
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});

describe('tier budget', () => {
  test('newcomer stops at 3/day; ambassador at 30/day', async () => {
    WineCorrectionProposal.countDocuments.mockResolvedValue(3);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('limit');

    mockUser('ambassador');
    WineCorrectionProposal.countDocuments.mockResolvedValue(29);
    expect((await ops.createFieldCorrection(ME, GOOD)).ok).toBe(true);
    WineCorrectionProposal.countDocuments.mockResolvedValue(30);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('limit');
  });

  test('the budget window is the last 24h of the proposer, any wine', async () => {
    await ops.createFieldCorrection(ME, GOOD);
    const q = WineCorrectionProposal.countDocuments.mock.calls[0][0];
    expect(String(q.proposer)).toBe(ME);
    expect(q.createdAt.$gt).toBeInstanceOf(Date);
  });
});

describe('creation', () => {
  test('invisible wine is not_found (visibility, not ownership)', async () => {
    findVisibleWine.mockResolvedValue(null);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('not_found');
  });

  test('creates with snapshot, stripped values and audit trail', async () => {
    const res = await ops.createFieldCorrection(ME, {
      ...GOOD,
      fields: { appellation: ' <b>Marlborough GI</b> ' },
      evidenceUrl: 'https://cloudybay.example/wine',
    }, { via: 'web' });

    expect(res.ok).toBe(true);
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      proposer: ME,
      wineDefinition: WINE,
      kind: 'field_correction',
      proposedFields: { appellation: 'Marlborough GI' },
      evidenceUrl: 'https://cloudybay.example/wine',
      currentSnapshot: {
        producer: 'Cloudy Bay',
        name: 'Sauvignon Blanc',
        appellation: null,
        region: 'Marlborough',
        country: 'New Zealand',
        classification: null,
      },
    }));
    expect(logAudit).toHaveBeenCalledWith(null, 'wine_proposal.user_create',
      expect.objectContaining({ type: 'wine' }),
      expect.objectContaining({ via: 'web', tier: 'newcomer', fields: ['appellation'] }));
  });

  test('E11000 (one pending per wine) becomes a friendly conflict', async () => {
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('listMineForWine', () => {
  test('caller + wine scoped, field_correction only', async () => {
    const chain = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
    WineCorrectionProposal.find.mockReturnValue(chain);
    const res = await ops.listMineForWine(ME, WINE);
    expect(res.ok).toBe(true);
    expect(WineCorrectionProposal.find).toHaveBeenCalledWith({
      proposer: ME,
      wineDefinition: { $eq: WINE },
      kind: 'field_correction',
    });
  });

  test('invalid wine id rejected', async () => {
    expect((await ops.listMineForWine(ME, 'nope')).code).toBe('invalid');
  });
});
