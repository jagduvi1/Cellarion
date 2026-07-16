/**
 * Shared consume/restore service — the ONE implementation behind both the REST
 * routes and the MCP tools. These tests pin the contract both surfaces rely
 * on: validation faults, exact field mutations, the save→rack-free ordering,
 * audit actions (which drive the SSE nudge), and the restore window.
 */

jest.mock('../models/Rack', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./search', () => ({ indexBottle: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./restockChecker', () => ({ checkRestockGap: jest.fn().mockResolvedValue(undefined) }));

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
