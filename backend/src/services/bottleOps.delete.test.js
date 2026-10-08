/**
 * snapshotBottleForDelete / restoreDeletedBottle — what MCP delete_bottle
 * stores before deleting, and what undo_last restores from.
 *
 * Pins: the snapshot holds the stored document, the rack slot, the registry
 * photos it points at and an import request the delete would withdraw, and
 * counts the own photos that cannot come back; the restore inserts the
 * bottle FIRST under the same id (the step that decides success), drops a
 * default photo that no longer exists, then re-links registry photos,
 * recreates the request and re-takes the slot only while it is free — all
 * best effort, so a hiccup after the insert never throws; and it refuses
 * when the world moved on (id in use, cellar gone, wine merged away).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Rack', () => ({ findOne: jest.fn(), updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Bottle', () => ({
  countDocuments: jest.fn(), exists: jest.fn(), findById: jest.fn(), collection: { insertOne: jest.fn() },
}));
jest.mock('../models/BottleImage', () => ({
  find: jest.fn(), countDocuments: jest.fn(), exists: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}),
}));
jest.mock('../models/WineRequest', () => ({
  findOne: jest.fn(), exists: jest.fn(), deleteOne: jest.fn().mockResolvedValue({}), collection: { insertOne: jest.fn() },
}));
jest.mock('../models/Cellar', () => ({ exists: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./rackOps', () => ({ placeBottleInRack: jest.fn() }));

const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('./audit');
const { placeBottleInRack } = require('./rackOps');
const { snapshotBottleForDelete, restoreDeletedBottle, removeBottleCascade } = require('./bottleOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const RAW = { _id: 'b1', cellar: 'c1', wineDefinition: 'w1', vintage: '2019', status: 'consumed', pendingWineRequest: 'r1', notes: 'kept', defaultImage: 'own1' };
const bottleDoc = () => ({ ...RAW, toObject: jest.fn(() => ({ ...RAW })), deleteOne: jest.fn().mockResolvedValue({}) });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('snapshotBottleForDelete', () => {
  test('the document, its slot, its registry photos and a request only it waits on; own photos counted', async () => {
    Rack.findOne.mockReturnValue(chain({ _id: 'rk', slots: [{ position: 3, bottle: 'other' }, { position: 4, bottle: 'b1' }] }));
    BottleImage.find.mockReturnValue(chain([{ _id: 'reg1' }]));
    BottleImage.countDocuments.mockResolvedValue(2);
    Bottle.countDocuments.mockResolvedValue(0);
    WineRequest.findOne.mockReturnValue(chain({ _id: 'r1', status: 'pending', wineName: 'X' }));
    const bottle = bottleDoc();

    const out = await snapshotBottleForDelete(bottle);

    expect(out.ownPhotos).toBe(2);
    expect(out.snapshot).toEqual({
      bottle: RAW,
      rack: { rackId: 'rk', position: 4 },
      registryPhotoIds: ['reg1'],
      wineRequest: { _id: 'r1', status: 'pending', wineName: 'X' },
    });
    // A snapshot deletes nothing.
    expect(bottle.deleteOne).not.toHaveBeenCalled();
  });

  test('a request other bottles still wait on is not taken (the delete keeps it)', async () => {
    Rack.findOne.mockReturnValue(chain(null));
    BottleImage.find.mockReturnValue(chain([]));
    BottleImage.countDocuments.mockResolvedValue(0);
    Bottle.countDocuments.mockResolvedValue(3);
    const out = await snapshotBottleForDelete(bottleDoc());
    expect(out.snapshot.wineRequest).toBeNull();
    expect(out.snapshot.rack).toBeNull();
    expect(WineRequest.findOne).not.toHaveBeenCalled();
  });
});

describe('removeBottleCascade anyStatus', () => {
  test('deletes a consumed bottle with anyStatus and audits the given detail', async () => {
    BottleImage.find.mockReturnValue(chain([]));
    Bottle.countDocuments.mockResolvedValue(0);
    const bottle = bottleDoc();
    expect((await removeBottleCascade(bottleDoc(), REQ, 'bottle.delete')).error.status).toBe(400);
    const out = await removeBottleCascade(bottle, REQ, 'bottle.delete', { anyStatus: true, auditDetail: { via: 'mcp' } });
    expect(out).toEqual({ removed: true });
    expect(bottle.deleteOne).toHaveBeenCalled();
    expect(WineRequest.deleteOne).toHaveBeenCalledWith({ _id: 'r1', status: 'pending' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.delete', expect.objectContaining({ id: 'b1' }), { via: 'mcp' });
  });
});

describe('restoreDeletedBottle', () => {
  const SNAP = {
    bottle: { ...RAW, status: 'active' },
    rack: { rackId: 'rk', position: 4 },
    registryPhotoIds: ['reg1'],
    wineRequest: { _id: 'r1', status: 'pending' },
  };
  const worldIntact = () => {
    Bottle.exists.mockResolvedValue(null);
    Cellar.exists.mockResolvedValue({ _id: 'c1' });
    WineDefinition.exists.mockResolvedValue({ _id: 'w1' });
    WineRequest.exists.mockResolvedValue(null);
    BottleImage.exists.mockResolvedValue({ _id: 'own1' });
    Bottle.findById.mockResolvedValue({ _id: 'b1', status: 'active' });
  };

  test('bottle first under the same id, then photos re-linked, request recreated, free slot re-taken', async () => {
    worldIntact();
    const order = [];
    Bottle.collection.insertOne.mockImplementation(async () => { order.push('bottle'); });
    WineRequest.collection.insertOne.mockImplementation(async () => { order.push('request'); });
    Rack.findOne.mockResolvedValue({ _id: 'rk', slots: [{ position: 3, bottle: 'other' }] });
    placeBottleInRack.mockResolvedValue({});
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(order).toEqual(['bottle', 'request']);
    expect(Bottle.collection.insertOne).toHaveBeenCalledWith(SNAP.bottle);
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ _id: { $in: ['reg1'] }, bottle: null }, { $set: { bottle: 'b1' } });
    expect(placeBottleInRack).toHaveBeenCalledWith(expect.objectContaining({ _id: 'rk' }), 4, 'b1', REQ);
    expect(out).toMatchObject({ placed: true, position: 4 });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.restore_deleted', expect.objectContaining({ id: 'b1' }), { via: 'undo', placed: true });
  });

  test('a default photo that was deleted with the bottle is dropped, not restored dangling', async () => {
    worldIntact();
    BottleImage.exists.mockResolvedValue(null);
    Rack.findOne.mockResolvedValue(null);
    await restoreDeletedBottle(SNAP, REQ);
    expect(Bottle.collection.insertOne.mock.calls[0][0].defaultImage).toBeNull();
    expect(SNAP.bottle.defaultImage).toBe('own1'); // the snapshot itself is not mutated
  });

  test('a slot taken since: back unplaced', async () => {
    worldIntact();
    Rack.findOne.mockResolvedValue({ _id: 'rk', slots: [{ position: 4, bottle: 'someone' }] });
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(placeBottleInRack).not.toHaveBeenCalled();
    expect(out).toMatchObject({ placed: false, position: null });
  });

  test('a failure after the bottle is back never throws: the restore still succeeds', async () => {
    worldIntact();
    WineRequest.collection.insertOne.mockRejectedValue(new Error('dup key'));
    Rack.findOne.mockRejectedValue(new Error('rack read failed'));
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ placed: false });
  });

  test.each([
    ['the id is in use again', () => Bottle.exists.mockResolvedValue({ _id: 'b1' }), /already exists/],
    ['the cellar is gone', () => Cellar.exists.mockResolvedValue(null), /cellar no longer exists/],
    ['the wine was merged away', () => WineDefinition.exists.mockResolvedValue(null), /merged or removed/],
  ])('refuses when %s, and writes nothing', async (_label, breakIt, message) => {
    worldIntact();
    breakIt();
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(out.error.status).toBe(409);
    expect(out.error.message).toMatch(message);
    expect(Bottle.collection.insertOne).not.toHaveBeenCalled();
    expect(WineRequest.collection.insertOne).not.toHaveBeenCalled();
  });
});
