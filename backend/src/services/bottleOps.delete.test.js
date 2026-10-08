/**
 * deleteBottleRecoverably / restoreDeletedBottle — the delete that MCP
 * delete_bottle runs and the restore undo_last runs.
 *
 * Pins: the delete takes its snapshot BEFORE the shared cascade (the stored
 * document, the rack slot, the registry photos it pointed at, an import
 * request this delete withdraws), runs the cascade for ANY status, and
 * audits as bottle.delete; the restore brings the document back under the
 * same id, re-links the registry photos, recreates a withdrawn request and
 * re-takes the rack slot only while it is free — and refuses when the world
 * moved on (id in use, cellar gone, wine merged away).
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
  find: jest.fn(), countDocuments: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}),
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
const { deleteBottleRecoverably, restoreDeletedBottle } = require('./bottleOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const RAW = { _id: 'b1', cellar: 'c1', wineDefinition: 'w1', vintage: '2019', status: 'consumed', pendingWineRequest: 'r1', notes: 'kept' };
const bottleDoc = () => ({
  ...RAW,
  toObject: jest.fn(() => ({ ...RAW })),
  deleteOne: jest.fn().mockResolvedValue({}),
});

beforeEach(() => jest.clearAllMocks());

describe('deleteBottleRecoverably', () => {
  test('snapshots first, then runs the shared cascade for any status and audits bottle.delete', async () => {
    Rack.findOne.mockReturnValue(chain({ _id: 'rk', slots: [{ position: 3, bottle: 'other' }, { position: 4, bottle: 'b1' }] }));
    BottleImage.find
      .mockReturnValueOnce(chain([{ _id: 'reg1' }])) // registry photos (snapshot)
      .mockReturnValueOnce(chain([{ _id: 'own1' }, { _id: 'own2' }])); // own photos (cascade)
    BottleImage.countDocuments.mockResolvedValue(2);
    Bottle.countDocuments.mockResolvedValueOnce(0).mockResolvedValueOnce(0); // nobody else waits on r1
    WineRequest.findOne.mockReturnValue(chain({ _id: 'r1', status: 'pending', wineName: 'X' }));
    const bottle = bottleDoc();

    const out = await deleteBottleRecoverably(bottle, REQ, { via: 'mcp' });

    expect(out.ownPhotosDeleted).toBe(2);
    expect(out.snapshot).toEqual({
      bottle: RAW,
      rack: { rackId: 'rk', position: 4 },
      registryPhotoIds: ['reg1'],
      wineRequest: { _id: 'r1', status: 'pending', wineName: 'X' },
    });
    // A consumed bottle is deleted too (anyStatus), and the request withdrawn.
    expect(bottle.deleteOne).toHaveBeenCalled();
    expect(WineRequest.deleteOne).toHaveBeenCalledWith({ _id: 'r1', status: 'pending' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.delete', expect.objectContaining({ id: 'b1' }), { via: 'mcp' });
  });

  test('a request other bottles still wait on is not snapshotted (the cascade keeps it)', async () => {
    Rack.findOne.mockReturnValue(chain(null));
    BottleImage.find.mockReturnValue(chain([]));
    BottleImage.countDocuments.mockResolvedValue(0);
    Bottle.countDocuments.mockResolvedValueOnce(3).mockResolvedValueOnce(3);
    const out = await deleteBottleRecoverably(bottleDoc(), REQ);
    expect(out.snapshot.wineRequest).toBeNull();
    expect(out.snapshot.rack).toBeNull();
    expect(WineRequest.findOne).not.toHaveBeenCalled();
    expect(WineRequest.deleteOne).not.toHaveBeenCalled();
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
    Bottle.findById.mockResolvedValue({ _id: 'b1', status: 'active' });
  };

  test('same id, registry photos re-linked, the withdrawn request recreated, the free slot re-taken', async () => {
    worldIntact();
    Rack.findOne.mockResolvedValue({ _id: 'rk', slots: [{ position: 3, bottle: 'other' }] });
    placeBottleInRack.mockResolvedValue({});
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(WineRequest.collection.insertOne).toHaveBeenCalledWith(SNAP.wineRequest);
    expect(Bottle.collection.insertOne).toHaveBeenCalledWith(SNAP.bottle);
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ _id: { $in: ['reg1'] }, bottle: null }, { $set: { bottle: 'b1' } });
    expect(placeBottleInRack).toHaveBeenCalledWith(expect.objectContaining({ _id: 'rk' }), 4, 'b1', REQ);
    expect(out).toMatchObject({ placed: true, position: 4 });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.restore_deleted', expect.objectContaining({ id: 'b1' }), { via: 'undo', placed: true });
  });

  test('a slot taken since: the bottle comes back unplaced', async () => {
    worldIntact();
    Rack.findOne.mockResolvedValue({ _id: 'rk', slots: [{ position: 4, bottle: 'someone' }] });
    const out = await restoreDeletedBottle(SNAP, REQ);
    expect(placeBottleInRack).not.toHaveBeenCalled();
    expect(out).toMatchObject({ placed: false, position: null });
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
  });
});
