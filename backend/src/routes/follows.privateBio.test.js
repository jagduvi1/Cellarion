/**
 * Audit 2026-09 O01-3 — a private profile's bio leaked through a public
 * user's follower / following lists. Only public profiles show a bio there,
 * and the visibility flag itself never leaves the server.
 */
const express = require('express');
const http = require('http');

const ME = 'a'.repeat(24);
const TARGET = 'b'.repeat(24);

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'a'.repeat(24), roles: ['user'] }; next(); },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/Notification', () => ({ create: jest.fn() }));
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: async () => ({ _id: 'b'.repeat(24), profileVisibility: 'public' }) })),
  updateOne: jest.fn(() => ({ catch: () => {} })),
}));
const mockFollowFind = jest.fn();
jest.mock('../models/Follow', () => ({
  find: (...a) => mockFollowFind(...a),
  countDocuments: jest.fn(async () => 2),
  deleteOne: jest.fn(),
}));

const router = require('./follows');

// A populated user doc: the route reads `_id` off the document AND spreads toObject().
const doc = (u) => ({ ...u, toObject: () => ({ ...u }) });
const listChain = (rows) => ({ sort: () => ({ skip: () => ({ limit: () => ({ populate: async () => rows }) }) }) });

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use('/api/follows', router);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  const rows = [
    { follower: doc({ _id: 'c'.repeat(24), username: 'open', displayName: 'Open', bio: 'I collect Barolo', profileVisibility: 'public' }) },
    { follower: doc({ _id: 'd'.repeat(24), username: 'quiet', displayName: 'Quiet', bio: 'private thoughts', profileVisibility: 'private' }) },
  ];
  mockFollowFind
    .mockReturnValueOnce(listChain(rows))                     // the list
    .mockReturnValueOnce({ select: async () => [] });          // "which do I follow"
});

test('a public profile keeps its bio, a private one does not, and the flag itself never leaves', async () => {
  const res = await fetch(`${base}/api/follows/${TARGET}/followers`);
  expect(res.status).toBe(200);
  const { users } = await res.json();
  expect(users).toHaveLength(2);
  const open = users.find((u) => u.username === 'open');
  const quiet = users.find((u) => u.username === 'quiet');
  expect(open.bio).toBe('I collect Barolo');
  expect(quiet).not.toHaveProperty('bio');
  expect(open).not.toHaveProperty('profileVisibility');
  expect(quiet).not.toHaveProperty('profileVisibility');
  expect(open.isFollowing).toBe(false);
});

test('the populate asks for the visibility flag it needs to decide', async () => {
  await fetch(`${base}/api/follows/${TARGET}/followers`);
  // The chain is opaque to the assertion, so pin the contract through the
  // route module's source instead: both lists must select profileVisibility.
  const src = require('fs').readFileSync(require.resolve('./follows'), 'utf8');
  expect(src).toContain("populate('follower', 'username displayName bio profileVisibility')");
  expect(src).toContain("populate('following', 'username displayName bio profileVisibility')");
});
