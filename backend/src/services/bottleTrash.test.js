/**
 * services/bottleTrash — "Recently deleted" for bulk-deleted bottles.
 *
 * Pinned: the trash row is written BEFORE the delete cascade (never gone
 * without a way back) and taken out again if the cascade refuses; the cascade
 * keeps the bottle's own photos; the label is read from the wine, or from the
 * import request a bottle still waits on. A restore uses the row's
 * wineDefinition (a merge since the delete re-pointed it), drops the row on
 * success and when the bottle exists again, and keeps it otherwise. The purge
 * deletes own photos (files first) only for bottles that are really gone,
 * then the rows; the daily run writes one audit row per owner.
 */
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/DeletedBottle', () => ({
  create: jest.fn(), deleteOne: jest.fn().mockResolvedValue({}), find: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({}), distinct: jest.fn(),
}));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ findById: jest.fn() }));
jest.mock('./bottleOps', () => ({
  snapshotBottleForDelete: jest.fn(), removeBottleCascade: jest.fn(), restoreDeletedBottle: jest.fn(),
}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const DeletedBottle = require('../models/DeletedBottle');
const WineDefinition = require('../models/WineDefinition');
const WineRequest = require('../models/WineRequest');
const { snapshotBottleForDelete, removeBottleCascade, restoreDeletedBottle } = require('./bottleOps');
const { logAudit } = require('./audit');
const { unlinkImageFiles } = require('./imageProcessor');
const { TRASH_DAYS, trashBottle, restoreTrashed, purgeTrashRows, runTrashRetentionPurge } = require('./bottleTrash');

const lean = (value) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(value) });
const REQ = { user: { id: 'u1' }, headers: {} };
const SNAP = { bottle: { _id: 'b1', cellar: 'c1', wineDefinition: 'w1' }, rack: { rackId: 'rk', position: 4 }, registryPhotoIds: [], wineRequest: null };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('trashBottle', () => {
  const bottle = { _id: 'b1', user: 'owner', cellar: 'c1', wineDefinition: 'w1', vintage: '2016', bottleSize: '750ml', status: 'active' };

  test('stores the snapshot and label first, then deletes keeping the own photos', async () => {
    const order = [];
    snapshotBottleForDelete.mockResolvedValue({ snapshot: SNAP, ownPhotos: 2 });
    WineDefinition.findById.mockReturnValue(lean({ name: 'Barolo', producer: 'Azelia' }));
    DeletedBottle.create.mockImplementation(async (doc) => { order.push('row'); return { _id: 't1', ...doc }; });
    removeBottleCascade.mockImplementation(async () => { order.push('delete'); return { removed: true }; });
    const deletedAt = new Date('2026-10-12T08:00:00Z');

    const out = await trashBottle(bottle, REQ, { batchId: 'batch1', deletedAt });

    expect(order).toEqual(['row', 'delete']);
    const doc = DeletedBottle.create.mock.calls[0][0];
    expect(doc).toMatchObject({
      user: 'owner', cellar: 'c1', deletedBy: 'u1', bottleId: 'b1', wineDefinition: 'w1', batchId: 'batch1', snapshot: SNAP, deletedAt,
      label: { name: 'Barolo', producer: 'Azelia', vintage: '2016', bottleSize: '750ml', status: 'active' },
    });
    expect((doc.purgeAt - deletedAt) / 86400000).toBe(TRASH_DAYS);
    expect(TRASH_DAYS).toBe(30);
    expect(removeBottleCascade).toHaveBeenCalledWith(bottle, REQ, 'bottle.delete',
      expect.objectContaining({ anyStatus: true, keepOwnPhotos: true, auditDetail: { trashed: true, batchId: 'batch1' } }));
    expect(out.error).toBeUndefined();
  });

  test('a bottle waiting on an import request is labelled from the request', async () => {
    snapshotBottleForDelete.mockResolvedValue({ snapshot: SNAP, ownPhotos: 0 });
    WineRequest.findById.mockReturnValue(lean({ wineName: 'Cuvée X', producer: 'Domaine Y' }));
    DeletedBottle.create.mockImplementation(async (doc) => doc);
    removeBottleCascade.mockResolvedValue({ removed: true });
    await trashBottle({ _id: 'b2', user: 'owner', cellar: 'c1', wineDefinition: null, pendingWineRequest: 'r1' }, REQ, { batchId: 'b' });
    expect(DeletedBottle.create.mock.calls[0][0].label).toMatchObject({ name: 'Cuvée X', producer: 'Domaine Y' });
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });

  test('a cascade that refuses takes the row out again', async () => {
    snapshotBottleForDelete.mockResolvedValue({ snapshot: SNAP, ownPhotos: 0 });
    WineDefinition.findById.mockReturnValue(lean(null));
    DeletedBottle.create.mockResolvedValue({ _id: 't9' });
    removeBottleCascade.mockResolvedValue({ error: { status: 400, message: 'no' } });
    const out = await trashBottle(bottle, REQ, { batchId: 'b' });
    expect(out.error).toEqual({ status: 400, message: 'no' });
    expect(DeletedBottle.deleteOne).toHaveBeenCalledWith({ _id: 't9' });
  });
});

describe('restoreTrashed', () => {
  const row = { _id: 't1', wineDefinition: 'w-keeper', snapshot: SNAP };

  test('restores onto the wine a merge re-pointed it to, and drops the row', async () => {
    restoreDeletedBottle.mockResolvedValue({ bottle: { _id: 'b1' }, placed: true, position: 4 });
    const out = await restoreTrashed(row, REQ);
    const [snapshot, req, opts] = restoreDeletedBottle.mock.calls[0];
    expect(snapshot.bottle.wineDefinition).toBe('w-keeper');
    expect(SNAP.bottle.wineDefinition).toBe('w1'); // the stored snapshot is not mutated
    expect(req).toBe(REQ);
    expect(opts).toEqual({ via: 'trash' });
    expect(out.placed).toBe(true);
    expect(DeletedBottle.deleteOne).toHaveBeenCalledWith({ _id: 't1' });
  });

  test('a bottle that exists again only loses its stale row', async () => {
    restoreDeletedBottle.mockResolvedValue({ error: { status: 409, code: 'exists', message: 'x' } });
    await restoreTrashed(row, REQ);
    expect(DeletedBottle.deleteOne).toHaveBeenCalledWith({ _id: 't1' });
  });

  test.each(['wine_gone', 'cellar_gone'])('keeps the row when the restore fails with %s', async (code) => {
    restoreDeletedBottle.mockResolvedValue({ error: { status: 409, code, message: 'x' } });
    const out = await restoreTrashed(row, REQ);
    expect(out.error.code).toBe(code);
    expect(DeletedBottle.deleteOne).not.toHaveBeenCalled();
  });
});

describe('purgeTrashRows', () => {
  test('deletes own photos (files first) of the bottles really gone, then every row', async () => {
    DeletedBottle.find.mockReturnValue(lean([{ _id: 't1', bottleId: 'b1' }, { _id: 't2', bottleId: 'b2' }]));
    Bottle.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['b2']) }); // b2 is back
    const photos = [{ _id: 'p1', originalUrl: null, processedUrl: '/uploads/p1.webp' }];
    BottleImage.find.mockReturnValue(lean(photos));
    const order = [];
    unlinkImageFiles.mockImplementation(async () => { order.push('file'); });
    BottleImage.deleteMany.mockImplementation(async () => { order.push('doc'); return {}; });

    const n = await purgeTrashRows({ purgeAt: { $lte: 'now' } });

    expect(n).toBe(2);
    const photoFilter = BottleImage.find.mock.calls[0][0];
    expect(photoFilter.bottle).toEqual({ $in: ['b1'] });
    expect(photoFilter.$or).toBeDefined(); // the OWN_PHOTO rule — registry photos stay
    expect(order).toEqual(['file', 'doc']);
    expect(DeletedBottle.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['t1', 't2'] } });
  });

  test('nothing matching: nothing touched', async () => {
    DeletedBottle.find.mockReturnValue(lean([]));
    expect(await purgeTrashRows({ cellar: 'c1' })).toBe(0);
    expect(BottleImage.deleteMany).not.toHaveBeenCalled();
    expect(DeletedBottle.deleteMany).not.toHaveBeenCalled();
  });
});

describe('runTrashRetentionPurge', () => {
  test('purges rows past purgeAt per owner, one audit row each', async () => {
    const now = new Date('2026-11-20T04:00:00Z');
    DeletedBottle.distinct.mockResolvedValue(['o1', 'o2']);
    DeletedBottle.find.mockImplementation((filter) => lean(filter.user === 'o1'
      ? [{ _id: 't1', bottleId: 'b1' }, { _id: 't2', bottleId: 'b2' }]
      : [{ _id: 't3', bottleId: 'b3' }]));
    Bottle.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    BottleImage.find.mockReturnValue(lean([]));

    const out = await runTrashRetentionPurge(now);

    expect(DeletedBottle.distinct).toHaveBeenCalledWith('user', { purgeAt: { $lte: now } });
    expect(DeletedBottle.find).toHaveBeenCalledWith({ user: 'o1', purgeAt: { $lte: now } });
    expect(out).toEqual({ purged: 3 });
    expect(logAudit).toHaveBeenCalledWith(null, 'bottle.trash_purge', { type: 'user', id: 'o1' }, { bottles: 2, retentionDays: 30 });
    expect(logAudit).toHaveBeenCalledWith(null, 'bottle.trash_purge', { type: 'user', id: 'o2' }, { bottles: 1, retentionDays: 30 });
  });

  test('one owner failing does not stop the others', async () => {
    DeletedBottle.distinct.mockResolvedValue(['bad', 'good']);
    DeletedBottle.find.mockImplementation((filter) => {
      if (filter.user === 'bad') throw new Error('boom');
      return lean([{ _id: 't1', bottleId: 'b1' }]);
    });
    Bottle.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    BottleImage.find.mockReturnValue(lean([]));
    const out = await runTrashRetentionPurge(new Date());
    expect(out).toEqual({ purged: 1 });
  });
});
