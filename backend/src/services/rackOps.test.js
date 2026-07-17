/**
 * Shared cellar/rack/placement service — REST + MCP call this, so the
 * procedural slot invariants and the move ordering are pinned by REAL
 * execution here (the 2b lesson: never let a mocked-out module hide a dead
 * path). Only the DB models + audit are mocked.
 */

jest.mock('../models/Cellar', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'cellar-new'; this.save = jest.fn().mockResolvedValue(undefined); });
  return M;
});
jest.mock('../models/Rack', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'rack-new'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  M.updateMany = jest.fn().mockResolvedValue({});
  return M;
});
jest.mock('../models/Bottle', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 32) }));
jest.mock('./bottleOps', () => ({ removeFromRacks: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./search', () => ({ indexBottle: jest.fn() }));

const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const { logAudit } = require('./audit');
const { removeFromRacks } = require('./bottleOps');
const { createCellar, createGridRack, placeBottleInRack, clearRackSlot, moveBottleToCellar, applyArrangement } = require('./rackOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const selectable = (doc) => ({ select: jest.fn().mockResolvedValue(doc) });

beforeEach(() => jest.clearAllMocks());

describe('createCellar', () => {
  test('trims name, audits cellar.create; duplicate → 409 conflict', async () => {
    const res = await createCellar({ name: '  Cave  ', description: ' x ' }, REQ);
    expect(res.cellar.name).toBe('Cave');
    expect(res.cellar.description).toBe('x');
    expect(logAudit).toHaveBeenCalledWith(REQ, 'cellar.create', expect.anything(), { name: 'Cave' });

    Cellar.mockImplementationOnce(function () { this.save = jest.fn().mockRejectedValue({ code: 11000 }); });
    expect((await createCellar({ name: 'Dup' }, REQ)).error).toMatchObject({ status: 409, code: 'duplicate' });
    expect((await createCellar({ name: '  ' }, REQ)).error.status).toBe(400);
  });
});

describe('createGridRack', () => {
  const cellar = { _id: 'c1', user: 'owner1' };
  test('defaults 4×8, owns to cellar owner, rejects bad type', async () => {
    const res = await createGridRack(cellar, { name: 'A' }, REQ);
    expect(res.rack.rows).toBe(4);
    expect(res.rack.cols).toBe(8);
    expect(res.rack.user).toBe('owner1');
    expect(res.rack.type).toBe('grid');
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.create', expect.anything(), { name: 'A' });
    expect((await createGridRack(cellar, { name: 'B', type: 'modular' }, REQ)).error.status).toBe(400);
  });
});

describe('placeBottleInRack', () => {
  const rack = (slots = []) => ({ _id: 'r1', cellar: 'c1', disabledPositions: [], slots, save: jest.fn().mockResolvedValue(undefined) });

  test('validates position range + disabled; bottle must be in the cellar', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1' }));
    expect((await placeBottleInRack(rack(), 99, 'b1', REQ)).error.message).toMatch(/Position must be 1/);
    const dr = rack(); dr.disabledPositions = [5];
    expect((await placeBottleInRack(dr, 5, 'b1', REQ)).error.message).toMatch(/disabled/);
    Bottle.findOne.mockReturnValue(selectable(null));
    expect((await placeBottleInRack(rack(), 5, 'bX', REQ)).error.status).toBe(404);
  });

  test('filter-then-push: clears other racks, drops old slot + occupant, reports displaced', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1' }));
    const r = rack([{ position: 3, bottle: 'b1' }, { position: 5, bottle: 'bOccupant' }]);
    const res = await placeBottleInRack(r, 5, 'b1', REQ);
    expect(res.error).toBeUndefined();
    expect(res.displaced).toBe('bOccupant');        // occupant of target reported
    expect(res.previousPosition).toBe(3);           // bottle's old slot
    // one bottle per slot AND one slot per bottle: only the new assignment remains for b1
    const b1Slots = r.slots.filter((s) => String(s.bottle) === 'b1');
    expect(b1Slots).toEqual([{ position: 5, bottle: 'b1' }]);
    expect(r.slots.find((s) => s.position === 5 && s.bottle === 'bOccupant')).toBeUndefined();
    // $inc __v: the cross-rack $pull must bump those racks' versions so a
    // concurrent whole-slots save() on one of them (auto_arrange) conflicts
    // cleanly instead of re-inserting the bottle it just lost.
    expect(Rack.updateMany).toHaveBeenCalledWith(
      { _id: { $ne: 'r1' }, cellar: 'c1', 'slots.bottle': 'b1' },
      { $pull: { slots: { bottle: 'b1' } }, $inc: { __v: 1 } }
    );
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.slot_assign', expect.anything(), { position: 5 });
  });

  test('VersionError on save → conflict (optimistic concurrency)', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1' }));
    const r = rack(); r.save = jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    expect((await placeBottleInRack(r, 5, 'b1', REQ)).error).toMatchObject({ status: 409, code: 'conflict' });
  });

  test('E11000 on save → conflict (unique slots.bottle index: bottle won a race into another rack)', async () => {
    // Prior-audit M4: two placements of the same bottle into two DIFFERENT
    // racks touch different documents, so only the unique multikey index can
    // stop the second — its duplicate-key error must map to the same clean
    // 409 the intra-rack VersionError path produces, not a 500.
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1' }));
    const r = rack(); r.save = jest.fn().mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const res = await placeBottleInRack(r, 5, 'b1', REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(res.error.message).toMatch(/another rack/);
  });
});

describe('applyArrangement', () => {
  test('E11000 on save → conflict, nothing applied (same M4 mapping as place)', async () => {
    const r = {
      _id: 'r1', cellar: 'c1', disabledPositions: [], slots: [],
      save: jest.fn().mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })),
    };
    const res = await applyArrangement(r, [{ position: 1, bottleId: 'b1' }], REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(res.error.message).toMatch(/another rack/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('clearRackSlot', () => {
  test('removes the position, reports the cleared bottle', async () => {
    const r = { _id: 'r1', cellar: 'c1', slots: [{ position: 5, bottle: 'b1' }], save: jest.fn().mockResolvedValue(undefined) };
    const res = await clearRackSlot(r, 5, REQ);
    expect(res.cleared).toBe('b1');
    expect(r.slots).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.slot_clear', expect.anything(), { position: 5 });
  });
});

describe('moveBottleToCellar', () => {
  const bottle = (over = {}) => ({
    _id: 'b1', status: 'active', vintage: '2019', cellarHistory: [], addedToCellarAt: new Date('2026-01-01'),
    createdAt: new Date('2026-01-01'), save: jest.fn().mockResolvedValue(undefined), ...over,
  });
  const src = { _id: 'c1', name: 'Source' };
  const dest = { _id: 'c2', name: 'Dest' };

  test('save-FIRST then unplace; seeds history both ends; dual audit', async () => {
    const b = bottle();
    const order = [];
    b.save.mockImplementation(async () => order.push('save'));
    removeFromRacks.mockImplementation(async () => order.push('unplace'));
    const res = await moveBottleToCellar(b, src, dest, REQ);
    expect(res.error).toBeUndefined();
    expect(b.cellar).toBe('c2');
    expect(order).toEqual(['save', 'unplace']); // move committed before the slot is freed
    expect(b.cellarHistory).toHaveLength(2);    // backfilled origin + new
    expect(b.cellarHistory[1]).toMatchObject({ cellar: 'c2', cellarName: 'Dest' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.move.out', expect.objectContaining({ cellarId: 'c1' }), expect.anything());
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.move.in', expect.objectContaining({ cellarId: 'c2' }), expect.anything());
    expect(res.from).toEqual({ cellarId: 'c1', cellarName: 'Source' });
  });

  test('guards: same cellar, non-active; VersionError → conflict', async () => {
    expect((await moveBottleToCellar(bottle(), src, src, REQ)).error.message).toMatch(/already in that cellar/);
    expect((await moveBottleToCellar(bottle({ status: 'drank' }), src, dest, REQ)).error.message).toMatch(/active/);
    const b = bottle(); b.save = jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    expect((await moveBottleToCellar(b, src, dest, REQ)).error).toMatchObject({ status: 409, code: 'conflict' });
    expect(removeFromRacks).not.toHaveBeenCalled(); // never unracked on a failed save
  });
});
