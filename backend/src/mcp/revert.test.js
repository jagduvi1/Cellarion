/**
 * revert.js — the shared reversal engine behind BOTH undo_last (newest) and the
 * in-app activity timeline (a specific row). Earlier phases were bitten by tests
 * that mocked bottleOps so thoroughly they proved nothing; this suite instead
 * pins the ENGINE's own decisions: which reversal each action dispatches to, the
 * write-scope and somm-role gates, all-or-nothing bulk safety, and the atomic
 * claim (so a double-revert loses cleanly).
 */

jest.mock('../models/McpActionLog', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineList', () => ({ findOne: jest.fn() }));
jest.mock('../config/constants', () => ({ CONSUMED_STATUSES: ['drank', 'gifted', 'sold', 'other'] }));
jest.mock('../services/bottleOps', () => ({
  RESTORE_WINDOW_MS: 5 * 86400000,
  removeBottleCascade: jest.fn(),
  updateBottleFields: jest.fn(),
  consumeBottle: jest.fn(),
  restoreBottle: jest.fn(),
}));
jest.mock('./toolUtil', () => ({ resolveBottleAccess: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn() }));
jest.mock('./structuralUndo', () => ({ undoStructural: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ findById: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => ({ deleteOne: jest.fn() }));
jest.mock('../services/journalOps', () => ({ deleteEntry: jest.fn() }));
jest.mock('../services/registryGc', () => ({ gcOrphanMintedWine: jest.fn().mockResolvedValue({ removed: false }) }));
jest.mock('../models/BottleImage', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));

const McpActionLog = require('../models/McpActionLog');
const bottleOps = require('../services/bottleOps');
const { resolveBottleAccess } = require('./toolUtil');
const { logAction } = require('./actionLedger');
const { undoStructural } = require('./structuralUndo');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const { revertLedgerRow, revertLatest, reversibleActionsFor, WRITE_REVERSIBLE, CONSUME_REVERSIBLE } = require('./revert');

const ok = jest.fn((summary, data) => ({ ok: true, summary, data }));
const fail = jest.fn((code, message) => ({ ok: false, code, message }));
const H = { ok, fail };
const ctx = (over = {}) => ({ user: { id: 'u1', roles: ['user'] }, scopes: ['read', 'consume', 'write'], req: {}, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' }); // claim succeeds by default
  McpActionLog.updateOne.mockResolvedValue({}); // unclaim (M1) — resolves so .catch() is safe
});

describe('reversibleActionsFor (scope gate)', () => {
  test('consume-only sees only consume/restore', () => {
    expect(reversibleActionsFor(['consume'])).toEqual(CONSUME_REVERSIBLE);
    expect(reversibleActionsFor(['read'])).toEqual(CONSUME_REVERSIBLE);
  });
  test('write unlocks the write-class reversals', () => {
    const r = reversibleActionsFor(['consume', 'write']);
    expect(r).toEqual([...CONSUME_REVERSIBLE, ...WRITE_REVERSIBLE]);
    expect(r).toContain('add');
    expect(r).toContain('move');
  });
});

describe('revertLatest', () => {
  const chain = (v) => ({ sort: () => Promise.resolve(v) });

  test('queries newest un-reversed non-undo row within window, scope-bounded', async () => {
    McpActionLog.findOne.mockReturnValue(chain(null));
    await revertLatest(ctx({ scopes: ['consume'] }), H);
    const q = McpActionLog.findOne.mock.calls[0][0];
    expect(q.user).toBe('u1');
    expect(q.reversed).toBe(false);
    expect(q.viaUndo).toEqual({ $ne: true });
    expect(q.action.$in).toEqual(['consume', 'restore', 'open', 'pour', 'close']); // no write actions without write scope
    expect(q.createdAt.$gte).toBeInstanceOf(Date);
  });

  test('no candidate → not_found', async () => {
    McpActionLog.findOne.mockReturnValue(chain(null));
    const res = await revertLatest(ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('revertLedgerRow dispatch', () => {
  test('structural actions (incl. arrange) delegate to undoStructural', async () => {
    undoStructural.mockResolvedValue({ ok: true });
    for (const action of ['cellar_create', 'rack_create', 'place', 'unplace', 'move', 'arrange']) {
      undoStructural.mockClear();
      await revertLedgerRow({ _id: 'r', action }, ctx(), H);
      expect(undoStructural).toHaveBeenCalledTimes(1);
    }
    expect(resolveBottleAccess).not.toHaveBeenCalled();
  });

  test('tasting_note: deletes the entry via journalOps, restores the previous rating, claims atomically', async () => {
    const { deleteEntry } = require('../services/journalOps');
    deleteEntry.mockResolvedValue({ deleted: true });
    const bottle = { _id: 'b1', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle });
    bottleOps.updateBottleFields.mockResolvedValue({ changes: {}, prev: {} });

    const row = {
      _id: 'r1', action: 'tasting_note', bottle: 'b1', cellar: 'c1',
      detail: { journalId: 'j1' }, prev: { field: 'rating', rating: 4, ratingScale: '5' },
    };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    // Shared journalOps delete → the reversal is audited like a manual deletion.
    expect(deleteEntry).toHaveBeenCalledWith('u1', 'j1', expect.anything(), { auditMeta: { via: 'undo' } });
    expect(bottleOps.updateBottleFields).toHaveBeenCalledWith(bottle, { rating: 4, ratingScale: '5' }, expect.anything());
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'r1', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    expect(logAction.mock.calls[0][1]).toMatchObject({ viaUndo: true, action: 'tasting_note' });
  });

  test('tasting_note: consumed-rating snapshot restores directly on the bottle', async () => {
    const { deleteEntry } = require('../services/journalOps');
    deleteEntry.mockResolvedValue({ deleted: true });
    const bottle = { _id: 'b2', consumedRating: 5, consumedRatingScale: '5', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle });

    const row = {
      _id: 'r2', action: 'tasting_note', bottle: 'b2',
      detail: { journalId: 'j2' }, prev: { field: 'consumedRating', consumedRating: null, consumedRatingScale: null },
    };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    expect(bottle.consumedRating).toBeUndefined(); // null snapshot → cleared
    expect(bottle.save).toHaveBeenCalled();
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled();
  });

  test('tasting_note: rating changed again since the note → entry removed but rating left as-is', async () => {
    const { deleteEntry } = require('../services/journalOps');
    deleteEntry.mockResolvedValue({ deleted: true });
    // The tool set 4/5 (recorded in result); the user has since re-rated to 5/5.
    const bottle = { _id: 'b4', rating: 5, ratingScale: '5', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle });
    const row = {
      _id: 'r4', action: 'tasting_note', bottle: 'b4',
      detail: { journalId: 'j4' }, prev: { field: 'rating', rating: 3, ratingScale: '5' },
      result: { data: { rating_recorded: { field: 'rating', value: 4, scale: '5' } } },
    };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/rating left as-is/);
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled(); // newer intent wins
    expect(bottle.save).not.toHaveBeenCalled();
  });

  test('tasting_note: inaccessible bottle refuses before any deletion or claim', async () => {
    const { deleteEntry } = require('../services/journalOps');
    resolveBottleAccess.mockResolvedValue(null);
    const res = await revertLedgerRow(
      { _id: 'r3', action: 'tasting_note', bottle: 'gone', detail: { journalId: 'j3' } }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('tasting_note: deleteEntry THROW after the claim unclaims the row so the undo can be retried', async () => {
    const { deleteEntry } = require('../services/journalOps');
    deleteEntry.mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b5', save: jest.fn() } });
    const row = {
      _id: 'r5', action: 'tasting_note', bottle: 'b5',
      detail: { journalId: 'j5' }, prev: { field: 'rating', rating: 4, ratingScale: '5' },
    };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(McpActionLog.updateOne).toHaveBeenCalledWith({ _id: 'r5' }, { $set: { reversed: false } });
    expect(logAction).not.toHaveBeenCalled();
  });

  test('tasting_note (occasion): deleteEntry THROW unclaims; a consumed-restore throw counts as failed, not thrown', async () => {
    const { deleteEntry } = require('../services/journalOps');
    const mkRow = () => ({
      _id: 'r6', action: 'tasting_note', cellar: 'c1',
      detail: { journalId: 'j6', count: 2, bottles: [{ bottle: 'ba', rating_changed: true }, { bottle: 'bb', rating_changed: true }] },
      prev: {
        ratings: [
          { bottle: 'ba', field: 'consumedRating', set: { value: 90, scale: '100' }, consumedRating: null, consumedRatingScale: null },
          { bottle: 'bb', field: 'consumedRating', set: { value: 80, scale: '100' }, consumedRating: null, consumedRatingScale: null },
        ],
      },
    });
    const ba = { _id: 'ba', consumedRating: 90, consumedRatingScale: '100', save: jest.fn().mockResolvedValue({}) };
    const bb = { _id: 'bb', consumedRating: 80, consumedRatingScale: '100', save: jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' })) };
    resolveBottleAccess.mockImplementation((_u, id) => Promise.resolve({ bottle: id === 'ba' ? ba : bb }));

    // 1) deleteEntry throws → conflict + unclaim, nothing restored yet.
    deleteEntry.mockRejectedValueOnce(Object.assign(new Error('v'), { name: 'VersionError' }));
    let res = await revertLedgerRow(mkRow(), ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(McpActionLog.updateOne).toHaveBeenCalledWith({ _id: 'r6' }, { $set: { reversed: false } });
    expect(ba.save).not.toHaveBeenCalled();

    // 2) deleteEntry ok, bb's restore save throws → honest partial report.
    deleteEntry.mockResolvedValue({ deleted: true });
    res = await revertLedgerRow(mkRow(), ctx(), H);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ ratings_restored: 1, ratings_failed: 1 });
  });

  test('attach_image: deletes the caller\'s own un-assigned image + its files, claims atomically', async () => {
    const BottleImage = require('../models/BottleImage');
    const { unlinkImageFiles } = require('../services/imageProcessor');
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b7' } });
    BottleImage.findOne.mockResolvedValue({ _id: 'img7' });
    BottleImage.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const row = { _id: 'r7', action: 'attach_image', bottle: 'b7', cellar: 'c1', detail: { imageId: 'img7' } };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    // Scoped to the caller's own, NOT-registry-assigned image (can't delete a shared wine photo).
    expect(BottleImage.findOne).toHaveBeenCalledWith({ _id: 'img7', uploadedBy: 'u1', assignedToWine: false });
    expect(unlinkImageFiles).toHaveBeenCalled();
    expect(BottleImage.deleteOne).toHaveBeenCalledWith({ _id: 'img7' });
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'r7', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    expect(res.data.image_removed).toBe(true);
  });

  test('attach_image: an already-gone image still marks the row undone (image_removed:false)', async () => {
    const BottleImage = require('../models/BottleImage');
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b8' } });
    BottleImage.findOne.mockResolvedValue(null); // deleted in the app since
    const res = await revertLedgerRow({ _id: 'r8', action: 'attach_image', bottle: 'b8', detail: { imageId: 'gone' } }, ctx(), H);
    expect(res.ok).toBe(true);
    expect(res.data.image_removed).toBe(false);
  });

  test('somm_maturity refused without somm/admin role — no mutation, no claim', async () => {
    const res = await revertLedgerRow({ _id: 'r', action: 'somm_maturity', detail: { profileId: 'p1' } }, ctx({ user: { id: 'u1', roles: ['user'] } }), H);
    expect(res).toMatchObject({ ok: false, code: 'forbidden_scope' });
    expect(WineVintageProfile.findById).not.toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('somm_maturity as somm restores the snapshot and claims', async () => {
    const profile = { _id: 'p1', save: jest.fn() };
    WineVintageProfile.findById.mockResolvedValue(profile);
    const row = { _id: 'r', action: 'somm_maturity', detail: { profileId: 'p1', vintage: 2015 },
      prev: { status: 'pending', peakFrom: 2020, relative: false, setBy: null, setAt: null } };
    const res = await revertLedgerRow(row, ctx({ user: { id: 'u1', roles: ['somm'] } }), H);
    expect(profile.status).toBe('pending');
    expect(profile.peakFrom).toBe(2020);
    expect(profile.save).toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'r', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ viaUndo: true, action: 'somm_maturity' }));
    expect(res.ok).toBe(true);
  });

  test('somm_price deletes the caller\'s price snapshot', async () => {
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = await revertLedgerRow({ _id: 'r', action: 'somm_price', detail: { entryId: 'e1', vintage: 2015 } }, ctx({ user: { id: 'u1', roles: ['admin'] } }), H);
    expect(WineVintagePrice.deleteOne).toHaveBeenCalledWith({ _id: 'e1', setBy: 'u1' });
    expect(res.ok).toBe(true);
  });

  test('bulk_add is all-or-nothing: an inactive member aborts BEFORE any remove or claim', async () => {
    resolveBottleAccess
      .mockResolvedValueOnce({ bottle: { _id: 'b1', status: 'active' } })
      .mockResolvedValueOnce({ bottle: { _id: 'b2', status: 'drank' } }); // moved on
    const res = await revertLedgerRow({ _id: 'r', action: 'bulk_add', detail: { bottles: ['b1', 'b2'] } }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bottleOps.removeBottleCascade).not.toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('bulk_add success claims then cascades every bottle', async () => {
    resolveBottleAccess
      .mockResolvedValueOnce({ bottle: { _id: 'b1', status: 'active' } })
      .mockResolvedValueOnce({ bottle: { _id: 'b2', status: 'active' } });
    bottleOps.removeBottleCascade.mockResolvedValue({});
    const res = await revertLedgerRow({ _id: 'r', action: 'bulk_add', detail: { bottles: ['b1', 'b2'] }, cellar: 'c1' }, ctx(), H);
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(bottleOps.removeBottleCascade).toHaveBeenCalledTimes(2);
    expect(res.data.removed_bottle_ids).toEqual(['b1', 'b2']);
  });

  test('add → removeBottleCascade', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, cellar: 'c1' } });
    bottleOps.removeBottleCascade.mockResolvedValue({});
    const res = await revertLedgerRow({ _id: 'r', action: 'add', bottle: 'b1' }, ctx(), H);
    expect(bottleOps.removeBottleCascade).toHaveBeenCalled();
    expect(res.data.undone).toBe('add_bottle');
    expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'undo_add', viaUndo: true }));
  });

  test('update → re-applies the prev snapshot', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, cellar: 'c1' } });
    bottleOps.updateBottleFields.mockResolvedValue({ changes: { price: 100 }, prev: { price: 200 } });
    const res = await revertLedgerRow({ _id: 'r', action: 'update', bottle: 'b1', prev: { price: 100 } }, ctx(), H);
    expect(bottleOps.updateBottleFields).toHaveBeenCalledWith(expect.anything(), { price: 100 }, expect.anything());
    // reverse row snapshots what we overwrote, so undo-of-undo works
    expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', prev: { price: 200 } }));
    expect(res.data.undone).toBe('update_bottle');
  });

  test('update with no prev is a conflict (nothing to restore)', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018 } });
    const res = await revertLedgerRow({ _id: 'r', action: 'update', bottle: 'b1', prev: {} }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled();
  });

  test('consume → restoreBottle, reverse row can re-consume', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, cellar: 'c1', consumedReason: 'drank', consumedNote: 'nice' } });
    bottleOps.restoreBottle.mockResolvedValue({ from: 'drank' });
    const res = await revertLedgerRow({ _id: 'r', action: 'consume', bottle: 'b1' }, ctx(), H);
    expect(bottleOps.restoreBottle).toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'restore', prev: expect.objectContaining({ reason: 'drank', note: 'nice' }) }));
    expect(res.data.status).toBe('active');
  });

  test('restore → refuses to re-consume a bottle consumed again since', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, status: 'drank' } });
    const res = await revertLedgerRow({ _id: 'r', action: 'restore', bottle: 'b1', prev: {} }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bottleOps.consumeBottle).not.toHaveBeenCalled();
  });

  test('restore → re-consumes an active bottle with the snapshotted reason', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, status: 'active' } });
    bottleOps.consumeBottle.mockResolvedValue({});
    const res = await revertLedgerRow({ _id: 'r', action: 'restore', bottle: 'b1', prev: { reason: 'gifted', note: 'x' } }, ctx(), H);
    expect(bottleOps.consumeBottle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'gifted', note: 'x' }), expect.anything());
    expect(res.ok).toBe(true);
  });

  test('lost claim race on a bottle action → conflict', async () => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', vintage: 2018, cellar: 'c1' } });
    bottleOps.removeBottleCascade.mockResolvedValue({});
    McpActionLog.findOneAndUpdate.mockResolvedValue(null); // someone reversed it first
    const res = await revertLedgerRow({ _id: 'r', action: 'add', bottle: 'b1' }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(logAction).not.toHaveBeenCalled();
  });

  test('inaccessible bottle → conflict, no mutation', async () => {
    resolveBottleAccess.mockResolvedValue(null);
    const res = await revertLedgerRow({ _id: 'r', action: 'consume', bottle: 'b1' }, ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bottleOps.restoreBottle).not.toHaveBeenCalled();
  });
});

describe('winelist undo (grand-audit M1 — un-claim on failure)', () => {
  const WineList = require('../models/WineList');
  const oid = (c) => c.repeat(24);
  const LIST = oid('1');
  const WINE = oid('e');
  const addRow = () => ({ _id: oid('f'), action: 'winelist_add', cellar: oid('c'),
    detail: { listId: LIST, listName: 'Menu', wineId: WINE, vintage: '2019', bottleSize: '750ml' } });

  const listWith = (entry, saveImpl) => ({
    _id: LIST, sections: [], autoGroupEntries: entry ? [entry] : [],
    save: saveImpl || jest.fn().mockResolvedValue(undefined),
  });
  const entry = () => ({ wine: WINE, vintage: '2019', bottleSize: '750ml', listPrice: 100 });

  test('winelist_add undo pulls the active-container entry and claims the row', async () => {
    const list = listWith(entry());
    WineList.findOne.mockResolvedValue(list);
    const res = await revertLedgerRow(addRow(), ctx(), H);
    expect(res.ok).toBe(true);
    expect(res.data.entry_removed).toBe(true);
    expect(list.autoGroupEntries).toHaveLength(0);
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalled();
  });

  test('a VersionError on save UN-CLAIMS the row so the undo can be retried', async () => {
    const err = new Error('conflict'); err.name = 'VersionError';
    const list = listWith(entry(), jest.fn().mockRejectedValue(err));
    WineList.findOne.mockResolvedValue(list);
    const res = await revertLedgerRow(addRow(), ctx(), H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    // The claim (reversed:true) must be released so a retry finds the row.
    expect(McpActionLog.updateOne).toHaveBeenCalledWith({ _id: oid('f') }, { $set: { reversed: false } });
  });
});

// Undo GC of minted registry wines (the launch-day orphan report): a batch or
// single add that CREATED the wine rolls it back too — via registryGc's
// conservative guards, never here.
describe('undo rolls back wines the undone action minted', () => {
  const { gcOrphanMintedWine } = require('../services/registryGc');

  test('bulk_add undo calls the GC for each recorded createdWineId', async () => {
    const b = { _id: 'b1', status: 'active', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle: b });
    bottleOps.removeBottleCascade.mockResolvedValue({ removed: true });
    gcOrphanMintedWine.mockResolvedValue({ removed: true });
    const row = { _id: 'r1', action: 'bulk_add', cellar: 'c1', detail: { bottles: ['b1'], createdWineIds: ['w1', 'w2'] } };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    expect(gcOrphanMintedWine).toHaveBeenCalledTimes(2);
    expect(gcOrphanMintedWine).toHaveBeenCalledWith('w1', expect.anything());
    expect(res.data.removed_wine_ids).toEqual(['w1', 'w2']);
    expect(res.summary).toMatch(/registry wine\(s\) rolled back/);
  });

  test('bulk_add undo without createdWineIds (older rows) never calls the GC', async () => {
    const b = { _id: 'b1', status: 'active', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle: b });
    bottleOps.removeBottleCascade.mockResolvedValue({ removed: true });
    const row = { _id: 'r1', action: 'bulk_add', cellar: 'c1', detail: { bottles: ['b1'] } };
    const res = await revertLedgerRow(row, ctx(), H);
    expect(res.ok).toBe(true);
    expect(gcOrphanMintedWine).not.toHaveBeenCalled();
  });

  test('single add undo GCs only when the ledger says wine_created', async () => {
    const b = { _id: 'b1', status: 'active', vintage: '2019', save: jest.fn() };
    resolveBottleAccess.mockResolvedValue({ bottle: b });
    bottleOps.removeBottleCascade.mockResolvedValue({ removed: true });
    McpActionLog.findOne.mockReturnValue({ sort: () => Promise.resolve(null) });

    gcOrphanMintedWine.mockResolvedValue({ removed: true });
    let res = await revertLedgerRow({ _id: 'r2', action: 'add', bottle: 'b1', detail: { wine: 'w9', wine_created: true } }, ctx(), H);
    expect(res.ok).toBe(true);
    expect(gcOrphanMintedWine).toHaveBeenCalledWith('w9', expect.anything());
    expect(res.data.removed_wine_id).toBe('w9');

    gcOrphanMintedWine.mockClear();
    res = await revertLedgerRow({ _id: 'r3', action: 'add', bottle: 'b1', detail: { wine: 'w9', wine_created: false } }, ctx(), H);
    expect(res.ok).toBe(true);
    expect(gcOrphanMintedWine).not.toHaveBeenCalled();
  });
});
