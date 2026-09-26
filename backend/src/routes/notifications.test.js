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
    req.user = { id: 'u1' };
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
