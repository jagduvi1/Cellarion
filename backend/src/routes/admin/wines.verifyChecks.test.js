/**
 * POST/DELETE /api/admin/wines/verify-checks + the per-rule suppression in
 * GET /producer-in-name.
 *
 * What is pinned here and why:
 *   - server-side re-detect: a stale client row cannot clear a rule the admin
 *     never saw on screen (mirrors strip-producer's recompute)
 *   - per-rule granularity: cleared for rule A still surfaces for rule B —
 *     the design's guarantee against bare-boolean staleness
 *   - operator-injection rejection BEFORE any query (house rule)
 *   - audit-log calls (CLAUDE.md GDPR rule 4)
 *   - no search re-index / no IndexNow: verification is not public content
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  ctor.bulkWrite = jest.fn();
  ctor.updateMany = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({}));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({}));
jest.mock('../../models/WineNotDuplicate', () => ({ find: jest.fn() }));
jest.mock('../../models/WineList', () => ({}));
jest.mock('../../models/WishlistItem', () => ({}));
jest.mock('../../models/PriceTrackingRequest', () => ({}));
jest.mock('../../models/PriceTrackingSkip', () => ({}));
jest.mock('../../models/CommunityWinePrice', () => ({}));
jest.mock('../../models/JournalEntry', () => ({}));
jest.mock('../../models/Recommendation', () => ({}));
jest.mock('../../models/RestockAlert', () => ({}));
jest.mock('../../models/WineRequest', () => ({}));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { NAME_CHECK_SELECT } = require('../../utils/nameChecks');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_A = '64b0000000000000000000b1';
const WINE_B = '64b0000000000000000000b2';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

// One chain serves both query shapes the routes issue:
//   scan:   find({}).select(...).sort(...).lean()
//   verify: find({ _id: { $in } }).select(...).lean()
const findChain = (rows) => {
  const select = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
    lean: jest.fn().mockResolvedValue(rows),
  });
  return { select };
};

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(findChain([]));
  WineDefinition.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
  WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 1 });
  Bottle.aggregate.mockResolvedValue([]);
});

const call = (method, path, body) => fetch(`${baseUrl}/api/admin/wines${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// Trips name-equals-producer.v1 (non-estate) and nothing else.
const OPUS = { _id: WINE_A, name: 'Opus One', producer: 'Opus One' };
// Trips dangling-name-tail.v1 only (the ticket's launch row).
const VINA = { _id: WINE_B, name: 'La Viña de', producer: 'Madaras' };

describe('POST /verify-checks', () => {
  test('records the clearance with $addToSet + verifiedAt, audits, and never re-indexes', async () => {
    WineDefinition.find.mockReturnValue(findChain([OPUS]));

    const res = await call('POST', '/verify-checks', {
      wineIds: [WINE_A], checks: ['name-equals-producer.v1'],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toBe(1);
    expect(data.notFlagged).toEqual([]);

    const ops = WineDefinition.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.update.$addToSet).toEqual({
      verifiedChecks: { $each: ['name-equals-producer.v1'] },
    });
    expect(ops[0].updateOne.update.$set.verifiedAt).toBeInstanceOf(Date);

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.verifyChecks',
      { type: 'wine', id: WINE_A },
      expect.objectContaining({ checks: ['name-equals-producer.v1'], updated: 1 })
    );
    expect(searchService.indexWine).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('server-side re-detect: a wine that does not trip the named rule is notFlagged, nothing written', async () => {
    WineDefinition.find.mockReturnValue(findChain([{ _id: WINE_A, name: 'Chardonnay', producer: 'Meerlust' }]));

    const res = await call('POST', '/verify-checks', {
      wineIds: [WINE_A], checks: ['name-equals-producer.v1'],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toBe(0);
    expect(data.notFlagged).toEqual([WINE_A]);
    expect(WineDefinition.bulkWrite).not.toHaveBeenCalled();
  });

  test('the projection covers every field the rules read (silent-divergence guard)', async () => {
    const chain = findChain([OPUS]);
    WineDefinition.find.mockReturnValue(chain);

    await call('POST', '/verify-checks', { wineIds: [WINE_A], checks: ['name-equals-producer.v1'] });

    const selectArg = chain.select.mock.calls[0][0];
    for (const field of NAME_CHECK_SELECT.split(' ')) {
      expect(selectArg).toContain(field);
    }
  });

  test.each([
    ['missing checks', { wineIds: [WINE_A] }],
    ['empty checks', { wineIds: [WINE_A], checks: [] }],
    ['unknown check id', { wineIds: [WINE_A], checks: ['bogus.v9'] }],
    ['operator-injection in checks', { wineIds: [WINE_A], checks: [{ $gt: '' }] }],
    ['operator-injection in wineIds', { wineIds: [{ $gt: '' }], checks: ['name-equals-producer.v1'] }],
    ['no valid wineIds', { wineIds: [], checks: ['name-equals-producer.v1'] }],
  ])('%s → 400, nothing queried', async (_label, body) => {
    const res = await call('POST', '/verify-checks', body);
    expect(res.status).toBe(400);
    expect(WineDefinition.find).not.toHaveBeenCalled();
    expect(WineDefinition.bulkWrite).not.toHaveBeenCalled();
  });

  test('more than 500 wineIds → 400', async () => {
    const ids = Array.from({ length: 501 }, (_, i) =>
      `64b00000000000000000${String(1000 + i).slice(1)}`);
    const res = await call('POST', '/verify-checks', { wineIds: ids, checks: ['name-equals-producer.v1'] });
    expect(res.status).toBe(400);
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });

  test('unknown wine ids → 404', async () => {
    WineDefinition.find.mockReturnValue(findChain([]));
    const res = await call('POST', '/verify-checks', { wineIds: [WINE_A], checks: ['name-equals-producer.v1'] });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /verify-checks', () => {
  test('pulls the rule ids and audits the undo', async () => {
    const res = await call('DELETE', '/verify-checks', {
      wineIds: [WINE_A], checks: ['name-equals-producer.v1'],
    });
    expect(res.status).toBe(200);

    const [filter, update] = WineDefinition.updateMany.mock.calls[0];
    expect(filter._id.$in.map(String)).toEqual([WINE_A]);
    expect(update).toEqual({ $pull: { verifiedChecks: { $in: ['name-equals-producer.v1'] } } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.unverifyChecks',
      { type: 'wine', id: WINE_A },
      expect.objectContaining({ checks: ['name-equals-producer.v1'] })
    );
  });

  test('bad checks → 400, nothing updated', async () => {
    const res = await call('DELETE', '/verify-checks', { wineIds: [WINE_A], checks: ['nope'] });
    expect(res.status).toBe(400);
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });
});

describe('GET /producer-in-name — per-rule suppression', () => {
  const get = (qs = '') => fetch(`${baseUrl}/api/admin/wines/producer-in-name${qs}`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });

  test('a wine cleared for the rule it trips leaves the queue (total 0, clearedCount 1)', async () => {
    WineDefinition.find.mockReturnValue(findChain([
      { ...OPUS, verifiedChecks: ['name-equals-producer.v1'] },
    ]));
    const data = await (await get()).json();
    expect(data.total).toBe(0);
    expect(data.clearedCount).toBe(1);
  });

  test('cleared for a DIFFERENT rule → still surfaces (per-rule granularity)', async () => {
    WineDefinition.find.mockReturnValue(findChain([
      { ...OPUS, verifiedChecks: ['dangling-name-tail.v1'] },
    ]));
    const data = await (await get()).json();
    expect(data.total).toBe(1);
    expect(data.wines[0].checks).toEqual(['name-equals-producer.v1']);
  });

  test('?includeVerified=1 is the audit view — cleared rows return anyway', async () => {
    WineDefinition.find.mockReturnValue(findChain([
      { ...OPUS, verifiedChecks: ['name-equals-producer.v1'] },
    ]));
    const data = await (await get('?includeVerified=1')).json();
    expect(data.total).toBe(1);
    expect(data.wines[0].verifiedChecks).toEqual(['name-equals-producer.v1']);
  });

  test('the dangling-tail row reports its rule with a null proposedName; strip rows keep theirs', async () => {
    WineDefinition.find.mockReturnValue(findChain([
      VINA,
      { _id: WINE_A, name: 'Meerlust Chardonnay', producer: 'Meerlust' },
    ]));
    const data = await (await get()).json();
    expect(data.total).toBe(2);
    const vina = data.wines.find(w => w._id === WINE_B);
    expect(vina.checks).toEqual(['dangling-name-tail.v1']);
    expect(vina.proposedName).toBeNull();
    const meerlust = data.wines.find(w => w._id === WINE_A);
    expect(meerlust.checks).toEqual(['producer-in-name.v1']);
    expect(meerlust.proposedName).toBe('Chardonnay');
  });

  test('the estate cohort is reachable via ?check= but absent from the default queue', async () => {
    const latour = { _id: WINE_A, name: 'Château Latour', producer: 'Château Latour' };
    WineDefinition.find.mockReturnValue(findChain([latour]));

    let data = await (await get()).json();
    expect(data.total).toBe(0); // not in the default queue

    WineDefinition.find.mockReturnValue(findChain([latour]));
    data = await (await get('?check=name-equals-producer-estate.v1')).json();
    expect(data.total).toBe(1);
    expect(data.wines[0].checks).toEqual(['name-equals-producer-estate.v1']);
  });

  test('?check=bogus → 400', async () => {
    const res = await get('?check=bogus');
    expect(res.status).toBe(400);
  });

  test('the envelope names what it covered (checkIds, allCheckIds, labels, scannedCount)', async () => {
    WineDefinition.find.mockReturnValue(findChain([OPUS]));
    const data = await (await get()).json();
    expect(data.checkIds).toEqual([
      'producer-in-name.v1', 'dangling-name-tail.v1', 'name-equals-producer.v1',
    ]);
    expect(data.allCheckIds).toContain('name-equals-producer-estate.v1');
    expect(data.checkLabelKeys['dangling-name-tail.v1']).toBe('danglingTail');
    expect(data.scannedCount).toBe(1);
  });
});
