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
  M.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  M.updateMany = jest.fn().mockResolvedValue({});
  M.updateOne = jest.fn().mockResolvedValue({});
  M.findOneAndUpdate = jest.fn().mockResolvedValue(null);
  return M;
});
jest.mock('../models/Bottle', () => ({ findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({
  getMaxPosition: jest.fn(() => 32),
  // Real validator — createGridRack's typeConfig gate is part of the pinned
  // contract (shared with the REST rack-update route).
  validateDoubleHeightRows: jest.requireActual('../utils/rackGeometry').validateDoubleHeightRows,
  validateCabinetConfig: jest.requireActual('../utils/rackGeometry').validateCabinetConfig,
}));
jest.mock('./bottleOps', () => ({ removeFromRacks: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./search', () => ({}));

const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const { logAudit } = require('./audit');
const { removeFromRacks } = require('./bottleOps');
const { createCellar, createGridRack, placeBottleInRack, clearRackSlot, moveBottleToCellar, applyArrangement } = require('./rackOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const selectable = (doc) => ({ select: jest.fn().mockResolvedValue(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  // A placed bottle is looked at again after the save: still in the cellar.
  Bottle.exists.mockResolvedValue({ _id: 'b1' });
  Rack.findOneAndUpdate.mockResolvedValue(null);
});

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

  // typeConfig arrived with the REST POST /racks delegation (MCP-audit H1) —
  // the grid branch of the route now runs through here, double-height rows
  // included.
  test('valid typeConfig.doubleHeightRows is stored; invalid rows / non-grid type are 400', async () => {
    const res = await createGridRack(cellar, { name: 'DH', rows: 4, cols: 6, typeConfig: { doubleHeightRows: [2] } }, REQ);
    expect(res.error).toBeUndefined();
    expect(res.rack.typeConfig).toEqual({ doubleHeightRows: [2] });

    const bad = await createGridRack(cellar, { name: 'DH2', rows: 4, cols: 6, typeConfig: { doubleHeightRows: [99] } }, REQ);
    expect(bad.error.status).toBe(400);
    expect(bad.error.message).toMatch(/between 1 and 4/);

    const nonGrid = await createGridRack(cellar, { name: 'DH3', type: 'hex', typeConfig: { doubleHeightRows: [1] } }, REQ);
    expect(nonGrid.error.status).toBe(400);
    expect(nonGrid.error.message).toMatch(/only supported on grid racks/);
  });

  test('cabinet: shelfRows is required and must match rows; a valid shape is stored as given', async () => {
    const cellar = { _id: 'c1', user: 'owner' };
    let res = await createGridRack(cellar, { name: 'Fridge', type: 'cabinet', rows: 3, cols: 6 }, REQ);
    expect(res.error.status).toBe(400);
    expect(res.error.message).toMatch(/shelfRows is required/);

    res = await createGridRack(cellar, { name: 'Fridge', type: 'cabinet', rows: 3, cols: 6, typeConfig: { shelfRows: [2, 2] } }, REQ);
    expect(res.error.status).toBe(400);
    expect(res.error.message).toMatch(/one entry per shelf/);

    res = await createGridRack(cellar, { name: 'Fridge', type: 'cabinet', rows: 3, cols: 6, typeConfig: { shelfRows: [1, 4, 6], twoDeep: true } }, REQ);
    expect(res.error).toBeUndefined();
    expect(res.rack).toMatchObject({ type: 'cabinet', rows: 3, cols: 6, typeConfig: { shelfRows: [1, 4, 6], twoDeep: true } });

    // shelfRows on a non-cabinet type is a client bug, not silently ignored
    res = await createGridRack(cellar, { name: 'G', type: 'grid', rows: 2, cols: 2, typeConfig: { shelfRows: [1, 1] } }, REQ);
    expect(res.error.message).toMatch(/cabinet racks only/);
  });

  test('rows and cols must be whole numbers in range — 5.5, "5", 0 or 21 are 400, never saved (audit 2026-09-16)', async () => {
    for (const dims of [{ rows: 5.5, cols: 6 }, { rows: '5', cols: 6 }, { rows: 5, cols: 0 }, { rows: 21, cols: 6 }]) {
      const res = await createGridRack(cellar, { name: 'Bad', type: 'grid', ...dims }, REQ);
      expect(res.error).toEqual(expect.objectContaining({ status: 400 }));
      expect(res.error.message).toMatch(/whole numbers/);
    }
    expect(Rack).not.toHaveBeenCalled();
  });

  test('trims the rack name', async () => {
    const res = await createGridRack(cellar, { name: '  Wall rack  ' }, REQ);
    expect(res.rack.name).toBe('Wall rack');
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

  test('a consumed bottle cannot be placed — consume clears the slot, so the reverse must hold (audit 2026-09-14)', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'drank' }));
    const res = await placeBottleInRack(rack(), 5, 'b1', REQ);
    expect(res.error.status).toBe(400);
    expect(res.error.message).toMatch(/consumed/);
    // an active bottle, or a legacy lookup without status, still places
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    expect((await placeBottleInRack(rack(), 5, 'b1', REQ)).error).toBeUndefined();
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
    expect(Rack.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: { $ne: 'r1' }, cellar: 'c1', 'slots.bottle': 'b1' },
      { $pull: { slots: { bottle: 'b1' } }, $inc: { __v: 1 } },
      expect.objectContaining({ lean: true })
    );
    // The row names the bottle and the one it pushed out, not only the slot.
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.slot_assign', expect.anything(), { position: 5, bottleId: 'b1', displaced: 'bOccupant' });
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

  test('a placement refused by a concurrent write gives the bottle back the slot it was taken from', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    // b1 sat in another rack of the cellar, slot 7.
    Rack.findOneAndUpdate.mockResolvedValue({ _id: 'rOther', slots: [{ position: 7, bottle: 'b1' }] });
    const r = rack(); r.save = jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    const res = await placeBottleInRack(r, 5, 'b1', REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    // Back into slot 7 of that rack, only if the slot is still free and the bottle sits nowhere else in it.
    expect(Rack.updateOne).toHaveBeenCalledWith(
      { _id: 'rOther', deletedAt: null, 'slots.position': { $ne: 7 }, 'slots.bottle': { $ne: 'b1' } },
      { $push: { slots: { position: 7, bottle: 'b1' } }, $inc: { __v: 1 } }
    );
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a bottle that lost the race into another rack is placed there: nothing is put back', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Rack.findOneAndUpdate.mockResolvedValue({ _id: 'rOther', slots: [{ position: 7, bottle: 'b1' }] });
    const r = rack(); r.save = jest.fn().mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    expect((await placeBottleInRack(r, 5, 'b1', REQ)).error).toMatchObject({ status: 409, code: 'conflict' });
    expect(Rack.updateOne).not.toHaveBeenCalled();
  });

  test('a bottle that left the cellar while it was being placed is taken out again, and the bottle it pushed out gets the slot back', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Bottle.exists.mockResolvedValue(null); // moved to another cellar, or drunk, meanwhile
    const r = rack([{ position: 5, bottle: 'bOccupant' }]);
    const res = await placeBottleInRack(r, 5, 'b1', REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(Bottle.exists).toHaveBeenCalledWith({ _id: 'b1', cellar: 'c1', status: { $in: ['active', null] } });
    expect(Rack.updateOne).toHaveBeenNthCalledWith(1, { _id: 'r1' }, { $pull: { slots: { bottle: 'b1' } }, $inc: { __v: 1 } });
    expect(Rack.updateOne).toHaveBeenNthCalledWith(2,
      { _id: 'r1', deletedAt: null, 'slots.position': { $ne: 5 }, 'slots.bottle': { $ne: 'bOccupant' } },
      { $push: { slots: { position: 5, bottle: 'bOccupant' } }, $inc: { __v: 1 } });
    expect(r.slots).toEqual([{ position: 5, bottle: 'bOccupant' }]);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a bottle that came from another rack is cleared from every other rack, also where the unique index is missing', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Rack.findOneAndUpdate.mockResolvedValue({ _id: 'rOther', slots: [{ position: 7, bottle: 'b1' }] });
    expect((await placeBottleInRack(rack(), 5, 'b1', REQ)).error).toBeUndefined();
    expect(Rack.updateMany).toHaveBeenCalledWith(
      { _id: { $ne: 'r1' }, cellar: 'c1', 'slots.bottle': 'b1' },
      { $pull: { slots: { bottle: 'b1' } }, $inc: { __v: 1 } }
    );
    // A bottle that sat in no other rack costs no second write.
    Rack.updateMany.mockClear();
    Rack.findOneAndUpdate.mockResolvedValue(null);
    expect((await placeBottleInRack(rack(), 6, 'b1', REQ)).error).toBeUndefined();
    expect(Rack.updateMany).not.toHaveBeenCalled();
  });

  test('a bottle drunk or moved while it was out of its rack is not put back to stay', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Rack.findOneAndUpdate.mockResolvedValue({ _id: 'rOther', slots: [{ position: 7, bottle: 'b1' }] });
    Rack.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Bottle.exists.mockResolvedValue(null); // gone from the shelf meanwhile
    const r = rack(); r.save = jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    expect((await placeBottleInRack(r, 5, 'b1', REQ)).error).toMatchObject({ status: 409 });
    expect(Rack.updateOne).toHaveBeenLastCalledWith({ _id: 'rOther' }, { $pull: { slots: { bottle: 'b1' } }, $inc: { __v: 1 } });
    Rack.updateOne.mockResolvedValue({});
  });

  test('a save that fails for another reason still puts the bottle back, then fails loudly', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Rack.findOneAndUpdate.mockResolvedValue({ _id: 'rOther', slots: [{ position: 7, bottle: 'b1' }] });
    const r = rack(); r.save = jest.fn().mockRejectedValue(new Error('disk full'));
    await expect(placeBottleInRack(r, 5, 'b1', REQ)).rejects.toThrow('disk full');
    expect(Rack.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'rOther', 'slots.position': { $ne: 7 } }),
      { $push: { slots: { position: 7, bottle: 'b1' } }, $inc: { __v: 1 } }
    );
  });

  test('a saved placement stands, with its audit row, when the bottle cannot be looked at again', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    Bottle.exists.mockRejectedValue(new Error('connection reset'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = rack();
    const res = await placeBottleInRack(r, 5, 'b1', REQ);
    warn.mockRestore();
    expect(res.error).toBeUndefined();
    expect(r.slots).toEqual([{ position: 5, bottle: 'b1' }]);
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.slot_assign', expect.anything(), { position: 5, bottleId: 'b1' });
  });

  test('an id sent in upper case names the same bottle: it keeps one slot', async () => {
    const stored = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    Bottle.findOne.mockReturnValue(selectable({ _id: stored, status: 'active' }));
    const r = rack([{ position: 5, bottle: stored }]);
    const res = await placeBottleInRack(r, 3, stored.toUpperCase(), REQ);
    expect(res.error).toBeUndefined();
    expect(res.previousPosition).toBe(5);
    expect(r.slots).toEqual([{ position: 3, bottle: stored }]);
  });

  test('a position is a whole slot number: one too large to print in full is refused, never read as slot 1', async () => {
    Bottle.findOne.mockReturnValue(selectable({ _id: 'b1', status: 'active' }));
    const r = rack([{ position: 1, bottle: 'bOccupant' }]);
    for (const position of [1e21, '1000000000000000000000', '5abc', 1.5, -1, '']) {
      const res = await placeBottleInRack(r, position, 'b1', REQ);
      expect([position, res.error && res.error.status]).toEqual([position, 400]);
    }
    expect(r.slots).toEqual([{ position: 1, bottle: 'bOccupant' }]);
    expect(r.save).not.toHaveBeenCalled();
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
    expect(logAudit).toHaveBeenCalledWith(REQ, 'rack.slot_clear', expect.anything(), { position: 5, bottleId: 'b1' });
  });

  test('an empty slot of the rack is fine; a position the rack does not have is refused and nothing is saved', async () => {
    const r = { _id: 'r1', cellar: 'c1', slots: [{ position: 1, bottle: 'b1' }], save: jest.fn().mockResolvedValue(undefined) };
    expect((await clearRackSlot(r, 5, REQ)).cleared).toBeNull();
    r.save.mockClear();
    for (const position of [0, 33, 1e21, '1000000000000000000000', '5abc']) {
      const res = await clearRackSlot(r, position, REQ);
      expect([position, res.error && res.error.status]).toEqual([position, 400]);
    }
    expect(r.slots).toEqual([{ position: 1, bottle: 'b1' }]);
    expect(r.save).not.toHaveBeenCalled();
  });

  test('a bottle can always be taken out, even from a position beyond the range of the rack', async () => {
    const r = { _id: 'r1', cellar: 'c1', slots: [{ position: 40, bottle: 'b1' }], save: jest.fn().mockResolvedValue(undefined) };
    expect((await clearRackSlot(r, 40, REQ)).cleared).toBe('b1');
    expect(r.slots).toEqual([]);
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
    expect((await moveBottleToCellar(bottle({ status: 'drank' }), src, dest, REQ)).error.message).toMatch(/in the cellar or on order/);
    const b = bottle(); b.save = jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    expect((await moveBottleToCellar(b, src, dest, REQ)).error).toMatchObject({ status: 409, code: 'conflict' });
    expect(removeFromRacks).not.toHaveBeenCalled(); // never unracked on a failed save
  });
});

describe('rack group', () => {
  const { normalizeRackGroup } = require('./rackOps');
  const cellar = { _id: 'c1', user: 'u1' };
  const REQ = { user: { id: 'u1' } };

  test('normalizeRackGroup trims, caps at 40 and turns blank into null; undefined stays undefined', () => {
    expect(normalizeRackGroup('  Basement ')).toBe('Basement');
    expect(normalizeRackGroup('')).toBeNull();
    expect(normalizeRackGroup('   ')).toBeNull();
    expect(normalizeRackGroup(null)).toBeNull();
    expect(normalizeRackGroup(42)).toBeNull();
    expect(normalizeRackGroup('x'.repeat(50))).toHaveLength(40);
    expect(normalizeRackGroup(undefined)).toBeUndefined();
  });

  test('createGridRack stores the normalised group, null when none was given', async () => {
    const withGroup = await createGridRack(cellar, { name: 'Left', group: ' Basement ' }, REQ);
    expect(withGroup.rack.group).toBe('Basement');
    const without = await createGridRack(cellar, { name: 'Fridge' }, REQ);
    expect(without.rack.group).toBeNull();
  });
});
