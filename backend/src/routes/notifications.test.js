/**
 * /api/notifications — the probe the browser asks instead of the full list.
 *
 * WHY THIS TEST EXISTS:
 * The app used to fetch the whole list (30 documents) every time a window got
 * focus, because the unread count alone can't see a list that changed while
 * the count stayed the same (one read on another device while a new one
 * arrives). The probe answers the count PLUS the newest notification's id; the
 * client refetches the list only when either differs from what it shows. That
 * only works if the probe's newest id is the list's first row — same filter,
 * same sort — or the client would refetch on every probe.
 */

jest.mock('../models/Notification', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  updateMany: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'No token provided' });
    req.user = { id: req.headers['x-user'] || 'u1' };
    // An API-token request (the Home Assistant integration), the way
    // apiTokenAuth marks one.
    if (req.headers['x-token'] === '1') req.apiToken = { id: 'tok', scopes: ['read'] };
    next();
  },
}));

const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { Types } = require('mongoose');
const Notification = require('../models/Notification');
const notificationsRouter = require('./notifications');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  // Like the real app (app.js mounts API rate limiters ahead of every router);
  // generous enough never to trip in these tests.
  app.use(rateLimit({ windowMs: 60 * 1000, max: 10000, standardHeaders: false, legacyHeaders: false }));
  app.use('/api/notifications', notificationsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});
beforeEach(() => jest.clearAllMocks());

const get = (path) => fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer jwt' } });

// A mongoose query double: chainable, resolves to `result` on lean().
const query = (result) => {
  const q = {
    sort: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(() => q),
    lean: jest.fn(async () => result),
  };
  return q;
};

const NEWEST = new Types.ObjectId('a'.repeat(24));
const OLDER = new Types.ObjectId('b'.repeat(24));

test('the probe answers the unread count and the newest notification id', async () => {
  Notification.countDocuments.mockResolvedValue(3);
  const probe = query({ _id: NEWEST });
  Notification.findOne.mockReturnValue(probe);

  const res = await get('/api/notifications/unread-count');

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ unreadCount: 3, newestId: 'a'.repeat(24) });
  // Only the caller's own notifications, and only the id is read.
  expect(Notification.countDocuments).toHaveBeenCalledWith({ user: 'u1', read: false });
  expect(Notification.findOne).toHaveBeenCalledWith({ user: 'u1' });
  expect(probe.select).toHaveBeenCalledWith('_id');
});

test('a user with no notifications gets newestId null', async () => {
  Notification.countDocuments.mockResolvedValue(0);
  Notification.findOne.mockReturnValue(query(null));

  const res = await get('/api/notifications/unread-count');

  expect(await res.json()).toEqual({ unreadCount: 0, newestId: null });
});

test("the probe's newest id comes from the same filter and sort as the list's first row", async () => {
  const list = query([{ _id: NEWEST }, { _id: OLDER }]);
  Notification.find.mockReturnValue(list);
  const probe = query({ _id: NEWEST });
  Notification.findOne.mockReturnValue(probe);
  Notification.countDocuments.mockResolvedValue(1);

  const listRes = await get('/api/notifications');
  const probeRes = await get('/api/notifications/unread-count');

  expect(Notification.findOne.mock.calls[0]).toEqual(Notification.find.mock.calls[0]);
  expect(probe.sort.mock.calls[0]).toEqual(list.sort.mock.calls[0]);
  // _id breaks ties between rows created in the same millisecond, so the
  // newest is stable between reads (release audit 2026-09-27, L).
  expect(probe.sort.mock.calls[0][0]).toEqual({ createdAt: -1, _id: -1 });
  expect((await listRes.json()).notifications[0]._id).toBe((await probeRes.json()).newestId);
});

test('a database error answers 500 without details', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  Notification.countDocuments.mockRejectedValue(new Error('connection lost'));
  Notification.findOne.mockReturnValue(query(null));

  const res = await get('/api/notifications/unread-count');

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'Failed to get unread count' });
  spy.mockRestore();
});

test('the probe requires a signed-in user', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/unread-count`);
  expect(res.status).toBe(401);
  expect(Notification.countDocuments).not.toHaveBeenCalled();
});

// ── API-token polls are answered from memory ─────────────────────────────────
// The Home Assistant integration asks for the list every few minutes per
// install (usage check 2026-10-09). A token request repeats the stored answer
// until the user's notifications version moves (a new row, a mark-read) or
// the entry ages out; browser requests never see the cache.
const { bumpNotificationsVersion } = require('../services/dataVersion');
const tokenGet = (path, user) => fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer cel_x', 'x-token': '1', 'x-user': user } });
const browserGet = (path, user) => fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer jwt', 'x-user': user } });

describe('API-token polls', () => {
  test('an unchanged token poll of the list is answered from memory', async () => {
    Notification.find.mockReturnValue(query([{ _id: NEWEST, read: false }]));
    Notification.countDocuments.mockResolvedValue(1);
    const a = await (await tokenGet('/api/notifications', 'tok-list')).json();
    const b = await (await tokenGet('/api/notifications', 'tok-list')).json();
    expect(b).toEqual(a);
    expect(Notification.find).toHaveBeenCalledTimes(1);
    expect(Notification.countDocuments).toHaveBeenCalledTimes(1);
  });

  test('an unchanged token poll of the probe is answered from memory', async () => {
    Notification.findOne.mockReturnValue(query({ _id: NEWEST }));
    Notification.countDocuments.mockResolvedValue(2);
    await tokenGet('/api/notifications/unread-count', 'tok-probe');
    const b = await (await tokenGet('/api/notifications/unread-count', 'tok-probe')).json();
    expect(b).toEqual({ unreadCount: 2, newestId: String(NEWEST) });
    expect(Notification.findOne).toHaveBeenCalledTimes(1);
  });

  test('a new row for the user (the version moves) brings a fresh answer', async () => {
    Notification.find.mockReturnValue(query([{ _id: OLDER, read: false }]));
    Notification.countDocuments.mockResolvedValue(1);
    await tokenGet('/api/notifications', 'tok-change');
    bumpNotificationsVersion('tok-change'); // what services/notifications does on insert
    Notification.find.mockReturnValue(query([{ _id: NEWEST, read: false }, { _id: OLDER, read: false }]));
    Notification.countDocuments.mockResolvedValue(2);
    const b = await (await tokenGet('/api/notifications', 'tok-change')).json();
    expect(b.unreadCount).toBe(2);
    expect(Notification.find).toHaveBeenCalledTimes(2);
  });

  test('marking read through the API moves the version, so the next poll is fresh', async () => {
    Notification.find.mockReturnValue(query([{ _id: NEWEST, read: false }]));
    Notification.countDocuments.mockResolvedValue(1);
    await tokenGet('/api/notifications', 'tok-read');
    Notification.updateMany.mockResolvedValue({ modifiedCount: 1 });
    const r = await fetch(`${baseUrl}/api/notifications/read-all`, { method: 'PUT', headers: { Authorization: 'Bearer cel_x', 'x-token': '1', 'x-user': 'tok-read' } });
    expect(r.status).toBe(200);
    Notification.countDocuments.mockResolvedValue(0);
    const b = await (await tokenGet('/api/notifications', 'tok-read')).json();
    expect(b.unreadCount).toBe(0);
    expect(Notification.find).toHaveBeenCalledTimes(2);
  });

  test('another user never shares an answer', async () => {
    Notification.find.mockReturnValue(query([{ _id: NEWEST, read: false }]));
    Notification.countDocuments.mockResolvedValue(1);
    await tokenGet('/api/notifications', 'tok-a');
    await tokenGet('/api/notifications', 'tok-b');
    expect(Notification.find).toHaveBeenCalledTimes(2);
  });

  test('browser requests (no API token) are never cached', async () => {
    Notification.find.mockReturnValue(query([{ _id: NEWEST, read: false }]));
    Notification.countDocuments.mockResolvedValue(1);
    await browserGet('/api/notifications', 'browser-u');
    await browserGet('/api/notifications', 'browser-u');
    expect(Notification.find).toHaveBeenCalledTimes(2);
  });
});
