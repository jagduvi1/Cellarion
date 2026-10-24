/**
 * POST /api/admin/search/reindex — the answer is the rebuild's real verdict.
 *
 * WHY THIS TEST EXISTS:
 * An admin presses Reindex after a restore, or after a deploy that adds a
 * filterable attribute, and trusts the answer. Meilisearch indexes in async
 * tasks: a task that FAILS still settles (waiting only throws on a timeout), a
 * sync that throws must reach the route, and the discussions upload has to
 * hand back its task uids or there is nothing to wait for. So "ok" and the
 * audit row may only follow when every task of both indexes succeeded.
 *
 * The real services/search runs against a mocked Meilisearch client; the
 * fire-and-forget callers (boot sync, taxonomy renames, import, scripts) keep
 * the default, which only logs.
 */
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../../models/Discussion', () => ({ find: jest.fn() }));
jest.mock('../../models/DiscussionReply', () => ({ find: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24), roles: ['admin'] }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const http = require('http');
const { Meilisearch } = require('meilisearch');
const WineDefinition = require('../../models/WineDefinition');
const Discussion = require('../../models/Discussion');
const DiscussionReply = require('../../models/DiscussionReply');
const { logAudit } = require('../../services/audit');
const searchService = require('../../services/search');
const router = require('./search');

const objectId = (n) => ({ toString: () => String(n).padStart(24, '0') });
const wineDoc = (n) => ({ _id: objectId(n), name: `Wine ${n}`, producer: 'Producer', grapes: [] });
const discussionDoc = (n) => ({ _id: objectId(n), title: `Thread ${n}`, body: '<p>Hello</p>' });

const asCursor = (docs) => ({
  [Symbol.asyncIterator]: async function* () { yield* docs; },
});
const queryOf = (docs) => {
  const chain = {};
  chain.populate = jest.fn(() => chain);
  chain.lean = jest.fn(() => chain);
  chain.cursor = jest.fn(() => asCursor(docs));
  return chain;
};

const wineIndex = {
  updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
  addDocuments: jest.fn(),
};
const discussionsIndex = {
  updateSettings: jest.fn().mockResolvedValue({ taskUid: 2 }),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
  addDocuments: jest.fn(),
};
const client = {
  health: jest.fn().mockResolvedValue({ status: 'available' }),
  index: jest.fn((name) => (name === 'wines' ? wineIndex : discussionsIndex)),
  getRawIndex: jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'index_not_found' })),
  tasks: { waitForTasks: jest.fn() },
};

// Task uid → the status Meilisearch settles it with (default 'succeeded').
let taskStatus;

let server;
let baseUrl;
beforeAll(async () => {
  Meilisearch.mockImplementation(() => client);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  await searchService.initialize();
  // initialize() checks the indexes in the background; let that settle.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

  const app = express();
  app.use('/api/admin/search', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  taskStatus = {};
  WineDefinition.find.mockReturnValue(queryOf([wineDoc(1), wineDoc(2)]));
  Discussion.find.mockReturnValue(queryOf([discussionDoc(3)]));
  DiscussionReply.find.mockReturnValue({
    sort: () => ({ select: () => ({ lean: async () => [] }) }),
  });
  wineIndex.addDocuments.mockResolvedValue({ taskUid: 11 });
  discussionsIndex.addDocuments.mockResolvedValue({ taskUid: 21 });
  client.tasks.waitForTasks.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, status: taskStatus[uid] || 'succeeded' })));
});

const reindex = () => fetch(`${baseUrl}/api/admin/search/reindex`, { method: 'POST' });

describe('POST /api/admin/search/reindex', () => {
  test('every task succeeded: 200, audited — and the discussions upload was waited for too', async () => {
    const res = await reindex();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true }));
    const waited = client.tasks.waitForTasks.mock.calls.map((c) => c[0]);
    expect(waited).toEqual([[11], [21]]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.search.reindex', {}, expect.any(Object));
  });

  test('a wines task that failed: 500, not audited', async () => {
    taskStatus[11] = 'failed';

    const res = await reindex();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'Reindex failed' }));
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a discussions task that failed: 500, not audited', async () => {
    taskStatus[21] = 'failed';

    const res = await reindex();

    expect(res.status).toBe(500);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('the wines upload throwing: 500, not audited', async () => {
    wineIndex.addDocuments.mockRejectedValue(new Error('payload too large'));

    const res = await reindex();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Reindex failed' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('the discussions upload throwing: 500, not audited', async () => {
    discussionsIndex.addDocuments.mockRejectedValue(new Error('meili down'));

    const res = await reindex();

    expect(res.status).toBe(500);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('Meilisearch unavailable: 503, nothing synced', async () => {
    jest.spyOn(searchService, 'getIsAvailable').mockReturnValueOnce(false);

    const res = await reindex();

    expect(res.status).toBe(503);
    expect(wineIndex.addDocuments).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('the sync functions for every other caller', () => {
  test('by default a failed sync only logs — fire-and-forget callers never see a rejection', async () => {
    wineIndex.addDocuments.mockRejectedValue(new Error('meili down'));
    discussionsIndex.addDocuments.mockRejectedValue(new Error('meili down'));

    await expect(searchService.fullSync()).resolves.toBeUndefined();
    await expect(searchService.fullSyncDiscussions()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  test('the discussions sync returns one task uid per uploaded chunk', async () => {
    Discussion.find.mockReturnValue(queryOf(Array.from({ length: 501 }, (_, i) => discussionDoc(i + 1))));
    discussionsIndex.addDocuments
      .mockResolvedValueOnce({ taskUid: 31 })
      .mockResolvedValueOnce({ taskUid: 32 });

    await expect(searchService.fullSyncDiscussions()).resolves.toEqual([31, 32]);
  });

  test('waitForTasks hands back the settled tasks', async () => {
    taskStatus[41] = 'failed';

    await expect(searchService.waitForTasks([41])).resolves.toEqual([{ uid: 41, status: 'failed' }]);
    await expect(searchService.waitForTasks([])).resolves.toEqual([]);
  });

  test('before Meilisearch is connected there is nothing to sync or wait for', async () => {
    let fresh;
    jest.isolateModules(() => { fresh = require('../../services/search'); });

    await expect(fresh.fullSync()).resolves.toEqual([]);
    await expect(fresh.fullSyncDiscussions()).resolves.toEqual([]);
    await expect(fresh.waitForTasks([1])).resolves.toEqual([]);
  });
});
