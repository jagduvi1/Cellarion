/**
 * GET /api/offline/snapshot answers 304 when nothing changed.
 *
 * WHY THIS TEST EXISTS:
 * The device's offline copy is checked on app start, every 15 minutes while
 * open and after the user's changes, and every check used to rebuild the whole
 * snapshot (~13 queries and a large JSON). The app now sends back the ETag of
 * the copy it holds; a match must answer 304 WITHOUT building anything, a
 * mismatch must rebuild, and the answer is never cached by a browser or proxy.
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../services/offlineSnapshot', () => ({
  snapshotTag: jest.fn(async () => 'W/"current-tag"'),
  buildOfflineSnapshot: jest.fn(async () => ({ schema: 1, userId: 'u1', cellars: [], bottles: [], racks: [], wines: {} })),
}));
// routes/cellars is heavy and only lends its image-URL resolver here.
jest.mock('./cellars', () => ({ attachBottleImageUrls: jest.fn() }));

const express = require('express');
const http = require('http');
const { snapshotTag, buildOfflineSnapshot } = require('../services/offlineSnapshot');
const offlineRouter = require('./offline');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/offline', offlineRouter); // the route carries its own per-user limiter
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});
beforeEach(() => jest.clearAllMocks());

const get = (headers = {}) => fetch(`${baseUrl}/api/offline/snapshot`, { headers });

test('a first fetch builds the snapshot and returns its tag, never cacheable', async () => {
  const res = await get();

  expect(res.status).toBe(200);
  expect(res.headers.get('etag')).toBe('W/"current-tag"');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.json()).schema).toBe(1);
  expect(snapshotTag).toHaveBeenCalledWith('u1');
  expect(buildOfflineSnapshot).toHaveBeenCalledTimes(1);
});

test('the tag of an unchanged copy answers 304 without building anything', async () => {
  const res = await get({ 'If-None-Match': 'W/"current-tag"' });

  expect(res.status).toBe(304);
  expect(res.headers.get('etag')).toBe('W/"current-tag"');
  expect(buildOfflineSnapshot).not.toHaveBeenCalled();
});

test('an older tag gets the rebuilt snapshot', async () => {
  const res = await get({ 'If-None-Match': 'W/"older-tag"' });

  expect(res.status).toBe(200);
  expect(buildOfflineSnapshot).toHaveBeenCalledTimes(1);
});

test('a failure answers 500 without details', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  snapshotTag.mockRejectedValueOnce(new Error('db down'));
  const res = await get();
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'Failed to build offline snapshot' });
  spy.mockRestore();
});
