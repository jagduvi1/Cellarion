/**
 * Shared consume/restore service — the ONE implementation behind both the REST
 * routes and the MCP tools. These tests pin the contract both surfaces rely
 * on: validation faults, exact field mutations, the save→rack-free ordering,
 * audit actions (which drive the SSE nudge), and the restore window.
 */

jest.mock('../models/Rack', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./search', () => ({ indexBottle: jest.fn(), removeBottle: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./restockChecker', () => ({ checkRestockGap: jest.fn().mockResolvedValue(undefined), resolveRestockAlerts: jest.fn().mockResolvedValue(undefined) }));

const Rack = require('../models/Rack');
const searchService = require('./search');
const { logAudit } = require('./audit');
const { checkRestockGap } = require('./restockChecker');
const { consumeBottle, restoreBottle, RESTORE_WINDOW_MS } = require('./bottleOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const freshBottle = (over = {}) => ({
  _id: 'b1', cellar: 'c1', status: 'active', vintage: '2015',
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('consumeBottle', () => {
  test('rejects a bad reason, an oversized note, and an unresolvable rating', async () => {
    expect((await consumeBottle(freshBottle(), { reason: 'evaporated' }, REQ)).error.status).toBe(400);
    expect((await consumeBottle(freshBottle(), { note: 'x'.repeat(1001) }, REQ)).error.status).toBe(400);
    // Rating out of range for its scale (missing scale defaults to '5', same as REST).
    expect((await consumeBottle(freshBottle(), { rating: 9 }, REQ)).error.status).toBe(400);
  });

  test('sets the consumed fields, saves, THEN frees the rack slot, reindexes, audits', async () => {
    const bottle = freshBottle();
    const callOrder = [];
    bottle.save.mockImplementation(async () => callOrder.push('save'));
    Rack.updateMany.mockImplementation(async () => callOrder.push('rack'));

    const res = await consumeBottle(bottle, { reason: 'gifted', note: 'to Anna <b>x</b>', rating: 4, ratingScale: '5' }, REQ);

    expect(res.error).toBeUndefined();
    expect(bottle.status).toBe('gifted');
    expect(bottle.consumedReason).toBe('gifted');
    expect(bottle.consumedAt).toBeInstanceOf(Date);
    expect(bottle.consumedNote).toBe('to Anna x'); // stripHtml applied
    expect(bottle.consumedRating).toBe(4);
    expect(bottle.consumedRatingScale).toBe('5');
    expect(callOrder).toEqual(['save', 'rack']); // failed save must not orphan a slot
    expect(Rack.updateMany).toHaveBeenCalledWith(
      { 'slots.bottle': 'b1' }, { $pull: { slots: { bottle: 'b1' } } }
    );
    expect(searchService.indexBottle).toHaveBeenCalledWith('b1');
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.consume',
      { type: 'bottle', id: 'b1', cellarId: 'c1' }, { reason: 'gifted' });
  });

  test('restock check fires only for "drank" and never for demo users', async () => {
    await consumeBottle(freshBottle(), { reason: 'gifted' }, REQ);
    expect(checkRestockGap).not.toHaveBeenCalled();

    await consumeBottle(freshBottle(), { reason: 'drank' }, REQ);
    expect(checkRestockGap).toHaveBeenCalledWith('u1', 'b1', 'c1');

    checkRestockGap.mockClear();
    await consumeBottle(freshBottle(), { reason: 'drank' }, { user: { id: 'd1', isDemo: true }, headers: {} });
    expect(checkRestockGap).not.toHaveBeenCalled();
  });
});

describe('restoreBottle', () => {
  const consumed = (over = {}) => freshBottle({
    status: 'drank', consumedAt: new Date(), consumedReason: 'drank',
    consumedNote: 'n', consumedRating: 4, consumedRatingScale: '5', ...over,
  });

  test('guards: active bottle, non-consumed status, expired window (with code)', async () => {
    expect((await restoreBottle(freshBottle(), REQ)).error.message).toMatch(/already active/);
    expect((await restoreBottle(freshBottle({ status: 'weird' }), REQ)).error.message).toMatch(/Only a consumed/);
    const old = consumed({ consumedAt: new Date(Date.now() - RESTORE_WINDOW_MS - 1000) });
    const res = await restoreBottle(old, REQ);
    expect(res.error.code).toBe('restore_window_expired');
  });

  test('clears every consumed-* field, reindexes, audits with the previous status', async () => {
    const bottle = consumed({ status: 'gifted', consumedReason: 'gifted' });
    const res = await restoreBottle(bottle, REQ);
    expect(res.error).toBeUndefined();
    expect(res.from).toBe('gifted');
    expect(bottle.status).toBe('active');
    for (const f of ['consumedAt', 'consumedReason', 'consumedNote', 'consumedRating', 'consumedRatingScale']) {
      expect(bottle[f]).toBeUndefined();
    }
    expect(bottle.save).toHaveBeenCalled();
    expect(searchService.indexBottle).toHaveBeenCalledWith('b1');
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.restore',
      { type: 'bottle', id: 'b1', cellarId: 'c1' }, { from: 'gifted' });
  });
});

// ── Write-path ops (Phase 2b) — REAL execution, mocked I/O only ─────────────
// The 2b audit found the first version of these functions had never been
// executed (the tool suite mocks bottleOps wholesale). These tests run the
// real code against the real validation utils.

jest.mock('../models/Bottle', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = 'new-bottle';
    this.createdAt = new Date('2026-07-01T00:00:00Z');
    this.save = jest.fn().mockResolvedValue(undefined);
    this.deleteOne = jest.fn().mockResolvedValue(undefined);
  });
  return M;
});
jest.mock('../models/BottleImage', () => ({
  find: jest.fn().mockResolvedValue([]),
  deleteMany: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({}),
}));
jest.mock('../models/WineRequest', () => ({ deleteOne: jest.fn().mockResolvedValue({}) }));
jest.mock('./embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));

const BottleModel = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const { embedSinglePair } = require('./embeddingJob');
const { enrichWineById } = require('./enrichmentJob');
const { addBottle, updateBottleFields, removeBottleCascade } = require('./bottleOps');

const CELLAR = { _id: 'c1', user: 'owner1', name: 'Main Cellar' };
const WINE = { _id: 'w1', name: 'Barolo' };

describe('addBottle (real execution)', () => {
  test('stores the PARSED vintage (not NV), drink years, journey seed, and fires gated AI calls', async () => {
    const res = await addBottle(CELLAR, WINE, {
      vintage: '2019', price: 25, notes: 'lovely <b>x</b>', drinkFrom: 2026, drinkTo: 2030,
    }, REQ);
    expect(res.error).toBeUndefined();
    const b = res.bottle;
    expect(b.vintage).toBe('2019');            // the H2 regression: was silently 'NV'
    expect(b.drinkFrom).toBe(2026);            // was silently dropped
    expect(b.drinkTo).toBe(2030);
    expect(b.notes).toBe('lovely x');
    expect(b.price).toBe(25);
    expect(b.priceSetAt).toBeInstanceOf(Date);
    expect(b.purchaseDate).toBeInstanceOf(Date); // REST default parity
    expect(b.addedToCellarAt).toEqual(b.createdAt);
    expect(b.cellarHistory).toEqual([{ cellar: 'c1', cellarName: 'Main Cellar', enteredAt: b.createdAt }]);
    expect(b.user).toBe('owner1');             // owner = cellar owner
    expect(embedSinglePair).toHaveBeenCalledWith('w1', '2019');
    expect(enrichWineById).toHaveBeenCalledWith('w1', { budgetUserId: 'u1' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.add', expect.anything(), { vintage: '2019' });
  });

  test('rejects bad vintage / reversed drink window / oversized notes', async () => {
    expect((await addBottle(CELLAR, WINE, { vintage: '20x9' }, REQ)).error.status).toBe(400);
    expect((await addBottle(CELLAR, WINE, { drinkFrom: 2030, drinkTo: 2026 }, REQ)).error.status).toBe(400);
    expect((await addBottle(CELLAR, WINE, { notes: 'x'.repeat(5001) }, REQ)).error.status).toBe(400);
  });

  test('empty vintage defaults to NV; no price → no priceSetAt', async () => {
    const res = await addBottle(CELLAR, WINE, {}, REQ);
    expect(res.bottle.vintage).toBe('NV');
    expect(res.bottle.priceSetAt).toBeUndefined();
  });
});

describe('updateBottleFields (real execution)', () => {
  const liveBottle = (over = {}) => {
    const b = new BottleModel({
      cellar: 'c1', status: 'active', vintage: '2019',
      price: 25, currency: 'USD', ratingScale: '5', ...over,
    });
    b.save.mockClear();
    return b;
  };

  test('drink-year SET actually sets (the H2 clear-instead-of-set regression)', async () => {
    const b = liveBottle();
    const res = await updateBottleFields(b, { drinkFrom: 2027 }, REQ);
    expect(res.error).toBeUndefined();
    expect(b.drinkFrom).toBe(2027);
    expect(res.changes).toEqual({ drinkFrom: 2027 });
    expect(res.prev).toEqual({ drinkFrom: null });
    expect(b.drinkWindowNotifiedStatus).toBeNull();
  });

  test('rating null CLEARS the rating (undo-of-rating-set path) with the ride-along scale', async () => {
    const b = liveBottle({ rating: 92, ratingScale: '100' });
    const res = await updateBottleFields(b, { rating: null, ratingScale: '5' }, REQ);
    expect(res.error).toBeUndefined();
    expect(b.rating).toBeNull();
    expect(b.ratingScale).toBe('5');
    expect(res.prev).toEqual({ rating: 92, ratingScale: '100' });
  });

  test('price clear also clears priceSetAt; price change re-anchors it', async () => {
    const b = liveBottle({ priceSetAt: new Date('2026-01-01') });
    await updateBottleFields(b, { price: null }, REQ);
    expect(b.priceSetAt).toBeUndefined();

    const b2 = liveBottle();
    await updateBottleFields(b2, { price: 30 }, REQ);
    expect(b2.price).toBe(30);
    expect(b2.priceSetAt.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  test('no-op update returns empty changes without saving', async () => {
    const b = liveBottle();
    const res = await updateBottleFields(b, { price: 25 }, REQ);
    expect(res.changes).toEqual({});
    expect(b.save).not.toHaveBeenCalled();
  });
});

describe('removeBottleCascade (real execution)', () => {
  test('active bottle: full cascade in order, then audit', async () => {
    const b = new BottleModel({ cellar: 'c1', status: 'active', pendingWineRequest: null });
    const res = await removeBottleCascade(b, REQ, 'bottle.undo');
    expect(res.removed).toBe(true);
    expect(Rack.updateMany).toHaveBeenCalled();          // slot freed
    expect(searchService.removeBottle).toHaveBeenCalledWith('new-bottle');
    expect(BottleImage.deleteMany).toHaveBeenCalledWith({ bottle: 'new-bottle', assignedToWine: false });
    expect(b.deleteOne).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.undo', expect.anything(), { reason: 'mistake' });
  });

  test('non-active bottle refuses', async () => {
    const b = new BottleModel({ cellar: 'c1', status: 'drank' });
    const res = await removeBottleCascade(b, REQ, 'bottle.undo');
    expect(res.error.status).toBe(400);
    expect(b.deleteOne).not.toHaveBeenCalled();
  });
});
