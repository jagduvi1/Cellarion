/**
 * revert.js — the somm curation undos audit what they reverse. The forward
 * writes (maturity review/reset/remove, price add/decline, correction proposal,
 * tasting profile) each leave an AuditLog row, so their reversal must too —
 * over undo_last and the in-app revert alike, hence `via: 'undo'`. The rows
 * are about a registry wine and carry no cellarId: they belong to the admin
 * audit log, never to a member's cellar history.
 */

jest.mock('../models/Bottle', () => ({ exists: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ exists: jest.fn() }));
jest.mock('../config/constants', () => ({ CONSUMED_STATUSES: ['drank', 'gifted', 'sold', 'other'], ORDERED_STATUS: 'ordered' }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({ RESTORE_WINDOW_MS: 5 * 86400000 }));
jest.mock('../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../services/search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/wineProfileOps', () => ({ restoreProfile: jest.fn() }));
jest.mock('./toolUtil', () => ({ resolveBottleAccess: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => ({ deleteOne: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ deleteOne: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ findById: jest.fn(), deleteOne: jest.fn() }));

const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { revertLedgerRow } = require('./revert');

const WINE = '64b000000000000000000001';
const ROW = '64b0000000000000000000a1';

const ok = jest.fn((summary, data) => ({ ok: true, summary, data }));
const fail = jest.fn((code, message) => ({ ok: false, code, message }));
const H = { ok, fail };
const req = { user: { id: 'u1', roles: ['somm'] }, headers: {} };
const sommCtx = { user: { id: 'u1', roles: ['somm'] }, scopes: ['read', 'consume', 'write'], req };

const versionError = () => Object.assign(new Error('version'), { name: 'VersionError' });

// The one audit row a successful undo writes: about the wine, no cellarId.
function expectAudit(action, detail) {
  expect(logAudit).toHaveBeenCalledTimes(1);
  const [r, a, resource, d] = logAudit.mock.calls[0];
  expect(r).toBe(req);
  expect(a).toBe(action);
  expect(resource).toEqual({ type: 'wine', id: WINE });
  expect(d).toEqual({ ...detail, via: 'undo', ledgerRow: ROW });
}

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
  McpActionLog.updateOne.mockResolvedValue({});
});

describe('somm_maturity', () => {
  const profileDoc = () => ({ _id: 'p1', wineDefinition: WINE, vintage: 2015, save: jest.fn().mockResolvedValue(undefined) });
  const prev = { status: 'pending', peakFrom: 2020, relative: false, setBy: null, setAt: null };

  test('undoing a review audits somm.maturity.review.undo', async () => {
    WineVintageProfile.findById.mockResolvedValue(profileDoc());
    const res = await revertLedgerRow({ _id: ROW, action: 'somm_maturity', detail: { profileId: 'p1', vintage: 2015 }, prev }, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.maturity.review.undo', { vintage: 2015, status: 'pending' });
  });

  test('undoing a reset_maturity_row audits somm.maturity.reset.undo', async () => {
    WineVintageProfile.findById.mockResolvedValue(profileDoc());
    const res = await revertLedgerRow({
      _id: ROW, action: 'somm_maturity', detail: { profileId: 'p1', vintage: 2015, reset: true },
      prev: { ...prev, status: 'reviewed', peakFrom: 2022 },
    }, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.maturity.reset.undo', { vintage: 2015, status: 'reviewed' });
  });

  test('a failed restore audits nothing', async () => {
    const profile = profileDoc();
    profile.save.mockRejectedValue(versionError());
    WineVintageProfile.findById.mockResolvedValue(profile);
    const res = await revertLedgerRow({ _id: ROW, action: 'somm_maturity', detail: { profileId: 'p1', vintage: 2015 }, prev }, sommCtx, H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a caller without the somm role audits nothing', async () => {
    const res = await revertLedgerRow({ _id: ROW, action: 'somm_maturity', detail: { profileId: 'p1' } },
      { ...sommCtx, user: { id: 'u1', roles: ['user'] } }, H);
    expect(res).toMatchObject({ ok: false, code: 'forbidden_scope' });
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('somm_price', () => {
  const row = { _id: ROW, action: 'somm_price', detail: { entryId: 'e1', wineId: WINE, vintage: 2015 } };

  test('removing the snapshot audits somm.price.add.undo', async () => {
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.price.add.undo', { vintage: 2015, entryId: 'e1', removed: true });
  });

  test('a snapshot that was already gone is audited as removed: false', async () => {
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.price.add.undo', { vintage: 2015, entryId: 'e1', removed: false });
  });
});

describe('somm_price_decline', () => {
  const row = {
    _id: ROW, action: 'somm_price_decline', detail: { wineId: WINE, vintage: 2015 },
    prev: { wineDefinition: WINE, vintage: 2015, requesters: [{ user: 'u2' }], skipCreated: true },
  };

  test('restoring the request audits somm.price.decline.undo', async () => {
    PriceTrackingRequest.findOneAndUpdate.mockResolvedValue({});
    PriceTrackingSkip.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.price.decline.undo', { vintage: 2015, skipLifted: true });
  });

  test('a failed restore audits nothing', async () => {
    PriceTrackingRequest.findOneAndUpdate.mockRejectedValue(new Error('db down'));
    await expect(revertLedgerRow(row, sommCtx, H)).rejects.toThrow('db down');
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('somm_proposal', () => {
  const row = { _id: ROW, action: 'somm_proposal', detail: { proposalId: 'pr1', wineId: WINE, kind: 'field' } };
  const pending = () => {
    const select = jest.fn().mockResolvedValue({ _id: 'pr1', status: 'pending', kind: 'field', wineDefinition: WINE });
    WineCorrectionProposal.findById.mockReturnValue({ select });
    return select;
  };

  test('withdrawing the proposal audits somm.wineProposal.create.undo against its wine', async () => {
    const select = pending();
    WineCorrectionProposal.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expect(select.mock.calls[0][0].split(' ')).toContain('wineDefinition');
    expectAudit('somm.wineProposal.create.undo', { proposalId: 'pr1', kind: 'field' });
  });

  test('a proposal decided in the race window audits nothing', async () => {
    pending();
    WineCorrectionProposal.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('somm_maturity_remove', () => {
  const row = { _id: ROW, action: 'somm_maturity_remove', detail: { profileId: 'p1', vintage: 2015 }, prev: { wineDefinition: WINE, vintage: 2015 } };

  test('re-seeding the queue row audits somm.maturity.remove.undo', async () => {
    WineVintageProfile.findOneAndUpdate.mockResolvedValue({});
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.maturity.remove.undo', { vintage: 2015 });
  });

  test('a failed re-seed audits nothing', async () => {
    WineVintageProfile.findOneAndUpdate.mockRejectedValue(new Error('db down'));
    await expect(revertLedgerRow(row, sommCtx, H)).rejects.toThrow('db down');
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('somm_wine_profile', () => {
  const row = { _id: ROW, action: 'somm_wine_profile', detail: { wineId: WINE, fields: ['description'] }, prev: { source: 'ai' } };
  const wineDoc = () => ({
    _id: WINE, producer: 'P', name: 'Douro Tinto', aiProfile: { source: 'ai' },
    save: jest.fn().mockResolvedValue(undefined),
  });

  test('restoring the profile audits somm.wineProfile.update.undo', async () => {
    WineDefinition.findById.mockResolvedValue(wineDoc());
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res.ok).toBe(true);
    expectAudit('somm.wineProfile.update.undo', { wine: 'P — Douro Tinto', source: 'ai' });
  });

  test('a failed restore audits nothing', async () => {
    const wine = wineDoc();
    wine.save.mockRejectedValue(versionError());
    WineDefinition.findById.mockResolvedValue(wine);
    const res = await revertLedgerRow(row, sommCtx, H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(logAudit).not.toHaveBeenCalled();
  });
});
