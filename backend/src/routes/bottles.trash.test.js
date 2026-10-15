/**
 * POST /api/bottles/bulk-delete, GET /api/bottles/trash and
 * POST /api/bottles/trash/restore — the bulk delete that moves bottles to a
 * cellar's "Recently deleted" for 30 days, and the way back (forum feedback
 * 2026-10-12: an import had to be deleted and done again).
 *
 * Pinned: a bulk delete trashes each bottle the caller may edit with ONE
 * batch id, skips the rest with a reason, and a bottle that throws is
 * reported without stopping the batch; the trash list is one cellar's,
 * editor+ only, and never sends the stored snapshots; a restore is scoped to
 * that cellar, takes ids or a batch, and reports why a bottle could not come
 * back. The two /trash routes are not swallowed by the /:id routes.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexBottle: jest.fn(), removeBottle: jest.fn(), indexWine: jest.fn(),
  bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined), reembedActiveVintages: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/rackOps', () => ({ moveBottleToCellar: jest.fn() }));
jest.mock('../services/bottleTrash', () => ({ TRASH_DAYS: 30, trashBottle: jest.fn(), restoreTrashed: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotForDate: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/PriceTrackingSkip', () => ({}));
jest.mock('../models/BottleImage', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/DeletedBottle', () => ({ find: jest.fn() }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const DeletedBottle = require('../models/DeletedBottle');
const { trashBottle, restoreTrashed } = require('../services/bottleTrash');
const { logAudit } = require('../services/audit');
// Loaded here, not inside app(): the router is the heaviest module in the
// tree, and requiring it inside the first test's 5 s budget times out under a
// parallel suite run.
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const MINE = '64b0000000000000000000c1';
const FOREIGN = '64b0000000000000000000c2';
const SHARED_VIEW = '64b0000000000000000000c3';
const SHARED_EDIT = '64b0000000000000000000c4';
const B = (n) => `64b0000000000000000000b${n}`;
const T = (n) => `64b0000000000000000000e${n}`;
const BATCH = '64b0000000000000000000a1';

const CELLARS = {
  [MINE]: { _id: MINE, user: USER, name: 'Home', deletedAt: null, members: [] },
  [FOREIGN]: { _id: FOREIGN, user: OTHER, name: 'Not mine', deletedAt: null, members: [] },
  [SHARED_VIEW]: { _id: SHARED_VIEW, user: OTHER, name: 'Look only', deletedAt: null, members: [{ user: USER, role: 'viewer' }] },
  [SHARED_EDIT]: { _id: SHARED_EDIT, user: OTHER, name: 'Household', deletedAt: null, members: [{ user: USER, role: 'editor' }] },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bottles', bottlesRouter);
  return a;
}

function call(a, method, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const headers = { authorization: `Bearer ${token}` };
      if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload || undefined);
    });
  });
}

// DeletedBottle.find(...).sort().limit().select().lean() for the list, and
// .sort().limit() awaited directly for the restore.
const chain = (rows) => {
  const c = {};
  for (const m of ['sort', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(rows));
  c.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return c;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  Cellar.findById.mockImplementation(async (id) => CELLARS[String(id)] || null);
  Bottle.find.mockResolvedValue([]);
  trashBottle.mockResolvedValue({ row: {} });
});

describe('POST /api/bottles/bulk-delete', () => {
  test('trashes every bottle the caller may edit under ONE batch, skips the rest with a reason', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: MINE, status: 'active' },
      { _id: B(2), cellar: SHARED_EDIT, status: 'drank' }, // editor of a shared cellar, any status
      { _id: B(3), cellar: FOREIGN, status: 'active' },    // not the caller's
      { _id: B(4), cellar: SHARED_VIEW, status: 'active' }, // viewer only
      // B(5) does not exist
    ]);
    const { status, body } = await call(app(), 'POST', '/api/bottles/bulk-delete', { bottleIds: [B(1), B(2), B(3), B(4), B(5), B(1)] });

    expect(status).toBe(200);
    expect(body.deleted).toBe(2);
    expect(body.deletedIds).toEqual([B(1), B(2)]);
    expect(body.skipped).toEqual([
      { id: B(3), reason: 'not_found' },
      { id: B(4), reason: 'not_found' },
      { id: B(5), reason: 'not_found' },
    ]);
    expect(trashBottle).toHaveBeenCalledTimes(2);
    const batches = trashBottle.mock.calls.map((c) => String(c[2].batchId));
    expect(new Set(batches).size).toBe(1);
    expect(String(body.batchId)).toBe(batches[0]);
    // The promise the confirm screen makes: back for 30 days.
    const days = (new Date(body.purgeAt) - trashBottle.mock.calls[0][2].deletedAt) / 86400000;
    expect(days).toBe(30);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bottle.bulk_delete', expect.objectContaining({ id: MINE }),
      expect.objectContaining({ requested: 5, deleted: 2, skipped: 3, retentionDays: 30 }));
  });

  test('onlyOnOrder: an order lowered from an out-of-date list takes off only bottles still on order', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: MINE, status: 'ordered' },
      { _id: B(2), cellar: MINE, status: 'active' }, // another member marked it as arrived meanwhile
    ]);
    const { status, body } = await call(app(), 'POST', '/api/bottles/bulk-delete', { bottleIds: [B(1), B(2)], onlyOnOrder: true });
    expect(status).toBe(200);
    expect(body.deletedIds).toEqual([B(1)]);
    expect(body.skipped).toEqual([{ id: B(2), reason: 'not_on_order' }]);
    expect(trashBottle).toHaveBeenCalledTimes(1);
  });

  test('a bottle that throws is reported and the rest of the batch still goes', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: MINE, status: 'active' },
      { _id: B(2), cellar: MINE, status: 'active' },
    ]);
    trashBottle.mockRejectedValueOnce(new Error('disk on fire')).mockResolvedValueOnce({ row: {} });
    const { status, body } = await call(app(), 'POST', '/api/bottles/bulk-delete', { bottleIds: [B(1), B(2)] });
    expect(status).toBe(200);
    expect(body.deletedIds).toEqual([B(2)]);
    expect(body.skipped).toEqual([{ id: B(1), reason: 'error' }]);
  });

  test.each([
    ['no ids', {}],
    ['an empty list', { bottleIds: [] }],
    ['a bad id', { bottleIds: ['nope'] }],
    ['more than the cap', { bottleIds: Array.from({ length: 501 }, (_, i) => `64b0000000000000000${String(i).padStart(5, '0')}`) }],
  ])('refuses %s without touching anything', async (_label, body) => {
    const res = await call(app(), 'POST', '/api/bottles/bulk-delete', body);
    expect(res.status).toBe(400);
    expect(trashBottle).not.toHaveBeenCalled();
  });
});

describe('GET /api/bottles/trash', () => {
  test("lists one cellar's trash, newest first, without the stored snapshots", async () => {
    const rows = [{ _id: T(1), batchId: BATCH, deletedAt: new Date('2026-10-12T08:00:00Z'), purgeAt: new Date('2026-11-11T08:00:00Z'), label: { name: 'Barolo', producer: 'Azelia', vintage: '2016', bottleSize: '750ml', status: 'active' } }];
    const q = chain(rows);
    DeletedBottle.find.mockReturnValue(q);
    const { status, body } = await call(app(), 'GET', `/api/bottles/trash?cellar=${MINE}`);
    expect(status).toBe(200);
    expect(DeletedBottle.find).toHaveBeenCalledWith({ cellar: MINE });
    expect(q.sort).toHaveBeenCalledWith({ deletedAt: -1, _id: 1 });
    expect(q.select).toHaveBeenCalledWith(expect.not.stringContaining('snapshot'));
    expect(body.retentionDays).toBe(30);
    expect(body.items).toEqual([{ id: T(1), batchId: BATCH, deletedAt: '2026-10-12T08:00:00.000Z', purgeAt: '2026-11-11T08:00:00.000Z', label: rows[0].label }]);
    // Not swallowed by GET /:id.
    expect(Bottle.findById).not.toHaveBeenCalled();
  });

  test.each([
    ['a cellar of someone else', FOREIGN, 404],
    ['a cellar the caller may only view', SHARED_VIEW, 404],
    ['no cellar', '', 400],
  ])('refuses %s', async (_label, cellarId, code) => {
    const { status } = await call(app(), 'GET', `/api/bottles/trash?cellar=${cellarId}`);
    expect(status).toBe(code);
    expect(DeletedBottle.find).not.toHaveBeenCalled();
  });
});

describe('POST /api/bottles/trash/restore', () => {
  test('restores a whole batch in this cellar and says why the others could not come back', async () => {
    const rows = [
      { _id: T(1), bottleId: B(1) },
      { _id: T(2), bottleId: B(2) },
      { _id: T(3), bottleId: B(3) },
    ];
    DeletedBottle.find.mockReturnValue(chain(rows));
    restoreTrashed
      .mockResolvedValueOnce({ bottle: {}, placed: true, position: 4 })
      .mockResolvedValueOnce({ error: { status: 409, code: 'wine_gone', message: 'gone' } })
      .mockResolvedValueOnce({ bottle: {}, placed: false, position: null });

    const { status, body } = await call(app(), 'POST', '/api/bottles/trash/restore', { cellar: MINE, batchId: BATCH });
    expect(status).toBe(200);
    const filter = DeletedBottle.find.mock.calls[0][0];
    expect(String(filter.cellar)).toBe(MINE);
    expect(String(filter.$or[0].batchId)).toBe(BATCH);
    expect(body).toEqual({ restored: 2, restoredIds: [B(1), B(3)], placed: 1, skipped: [{ id: T(2), reason: 'wine_gone' }] });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bottle.bulk_restore', expect.objectContaining({ id: MINE }),
      expect.objectContaining({ requested: 3, restored: 2, skipped: 1, batchId: BATCH }));
  });

  test('restores picked rows by id', async () => {
    DeletedBottle.find.mockReturnValue(chain([{ _id: T(1), bottleId: B(1) }]));
    restoreTrashed.mockResolvedValue({ bottle: {}, placed: false });
    const { status, body } = await call(app(), 'POST', '/api/bottles/trash/restore', { cellar: SHARED_EDIT, ids: [T(1)] });
    expect(status).toBe(200);
    expect(body.restoredIds).toEqual([B(1)]);
    const filter = DeletedBottle.find.mock.calls[0][0];
    expect(filter.$or[0]._id.$in.map(String)).toEqual([T(1)]);
  });

  test.each([
    ['a cellar the caller may only view', { cellar: SHARED_VIEW, batchId: BATCH }, 404],
    ['nothing to restore', { cellar: MINE }, 400],
    ['a bad id', { cellar: MINE, ids: ['nope'] }, 400],
  ])('refuses %s', async (_label, body, code) => {
    const res = await call(app(), 'POST', '/api/bottles/trash/restore', body);
    expect(res.status).toBe(code);
    expect(restoreTrashed).not.toHaveBeenCalled();
  });
});

// "Added by mistake?" on the bottle page. It used to delete for good (the one
// delete with no way back); it now moves the bottle to "Recently deleted"
// like every other delete, keeping its own `bottle.undo` audit action.
describe('POST /api/bottles/:id/undo', () => {
  test('moves an active bottle to Recently deleted under the bottle.undo action, with its batch id', async () => {
    Bottle.findById.mockResolvedValue({ _id: B(1), cellar: MINE, user: USER, status: 'active' });
    const { status, body } = await call(app(), 'POST', `/api/bottles/${B(1)}/undo`);

    expect(status).toBe(200);
    expect(trashBottle).toHaveBeenCalledTimes(1);
    const opts = trashBottle.mock.calls[0][2];
    expect(opts.auditAction).toBe('bottle.undo');
    expect(String(body.batchId)).toBe(String(opts.batchId));
    expect((new Date(body.purgeAt) - opts.deletedAt) / 86400000).toBe(30);
  });

  test('an on-order bottle ("Cancel order") goes the same way', async () => {
    Bottle.findById.mockResolvedValue({ _id: B(1), cellar: MINE, user: USER, status: 'ordered' });
    const { status } = await call(app(), 'POST', `/api/bottles/${B(1)}/undo`);
    expect(status).toBe(200);
    expect(trashBottle).toHaveBeenCalledTimes(1);
  });

  test('a consumed bottle is refused and nothing is moved', async () => {
    Bottle.findById.mockResolvedValue({ _id: B(1), cellar: MINE, user: USER, status: 'drank' });
    const { status } = await call(app(), 'POST', `/api/bottles/${B(1)}/undo`);
    expect(status).toBe(400);
    expect(trashBottle).not.toHaveBeenCalled();
  });

  test('a viewer cannot', async () => {
    Bottle.findById.mockResolvedValue({ _id: B(1), cellar: SHARED_VIEW, user: OTHER, status: 'active' });
    const { status } = await call(app(), 'POST', `/api/bottles/${B(1)}/undo`);
    expect([403, 404]).toContain(status);
    expect(trashBottle).not.toHaveBeenCalled();
  });
});
