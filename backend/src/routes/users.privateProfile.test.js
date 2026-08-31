/**
 * GET /api/users/public/:userId — what a PRIVATE profile answers.
 *
 * WHY THIS TEST EXISTS:
 * The blanket 404 from security PR #519 kept ObjectId enumeration from
 * confirming an account exists. But the rest of the app contradicted it: a
 * forum post shows its author's username and links to this page, so clicking
 * a visible name answered "User not found" for 84 of 346 accounts
 * (Johan, 2026-08-31).
 *
 * The narrowed rule: a private member who has ALREADY published under this
 * identity (a discussion, a non-deleted reply, or a public review) gets an
 * identity-only stub — everything else about them stays hidden. A private
 * member who never posted keeps the indistinguishable 404, which is the
 * property #519 actually bought. These tests pin BOTH halves, because
 * loosening the second one silently would undo the hardening.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Discussion', () => ({ exists: jest.fn() }));
jest.mock('../models/DiscussionReply', () => ({ exists: jest.fn() }));
jest.mock('../models/Review', () => ({ exists: jest.fn() }));
jest.mock('../models/Follow', () => ({ findOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(),
  bulkIndexWines: jest.fn(), bulkIndexBottles: jest.fn(), fullSync: jest.fn(),
  fullSyncBottles: jest.fn(), waitForTasks: jest.fn(), indexDiscussion: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const Review = require('../models/Review');
const Follow = require('../models/Follow');
const usersRouter = require('./users');

const VIEWER = '64b000000000000000000001';
const TARGET = '64b000000000000000000002';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const token = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret');
const get = (targetId, viewerId = VIEWER) =>
  fetch(`${baseUrl}/api/users/public/${targetId}`, { headers: { Authorization: `Bearer ${token(viewerId)}` } });

/** The route calls User.findById(id).select(...) and awaits the result. */
const mockUser = (over = {}) => {
  const doc = {
    _id: TARGET, username: 'boubou17', displayName: null, bio: 'a secret bio',
    followersCount: 3, followingCount: 4, reviewCount: 5,
    profileVisibility: 'private', createdAt: new Date('2026-08-31'),
    plan: 'free', preferences: { ratingScale: '5' },
    contribution: { totalScore: 99, tier: 'expert' },
    ...over,
  };
  User.findById.mockReturnValue({ select: () => doc });
  return doc;
};

const noFootprint = () => {
  Discussion.exists.mockResolvedValue(null);
  DiscussionReply.exists.mockResolvedValue(null);
  Review.exists.mockResolvedValue(null);
};

beforeEach(() => {
  jest.clearAllMocks();
  Follow.findOne.mockResolvedValue(null);
  noFootprint();
});

describe('private profile with no public content', () => {
  test('is indistinguishable from a non-existent account (the #519 property)', async () => {
    mockUser();
    const res = await get(TARGET);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('User not found');
  });

  test('answers exactly like a genuinely missing user — same status, same body', async () => {
    mockUser();
    const privateRes = await get(TARGET);
    const privateBody = await privateRes.json();

    User.findById.mockReturnValue({ select: () => null });
    const missingRes = await get('64b0000000000000000000ff');
    const missingBody = await missingRes.json();

    expect(privateRes.status).toBe(missingRes.status);
    expect(privateBody).toEqual(missingBody);
  });

  test('a soft-deleted reply does not count as public content', async () => {
    mockUser();
    const res = await get(TARGET);
    expect(res.status).toBe(404);
    // The reply check must exclude deleted rows — its body is replaced with a
    // placeholder, so the author's name is no longer on display anywhere.
    expect(DiscussionReply.exists).toHaveBeenCalledWith({ author: TARGET, isDeleted: { $ne: true } });
  });

  test('a private review does not count as public content', async () => {
    mockUser();
    await get(TARGET);
    expect(Review.exists).toHaveBeenCalledWith({ author: TARGET, visibility: 'public' });
  });
});

describe('private profile whose owner has posted publicly', () => {
  test.each([
    ['a discussion', () => Discussion.exists.mockResolvedValue({ _id: 'd1' })],
    ['a reply', () => DiscussionReply.exists.mockResolvedValue({ _id: 'r1' })],
    ['a public review', () => Review.exists.mockResolvedValue({ _id: 'v1' })],
  ])('%s earns the private stub instead of a 404', async (_label, arrange) => {
    mockUser();
    arrange();
    const res = await get(TARGET);
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user).toMatchObject({ username: 'boubou17', isPrivate: true, profileVisibility: 'private' });
  });

  test('the stub leaks nothing beyond the name already shown on their posts', async () => {
    mockUser();
    Discussion.exists.mockResolvedValue({ _id: 'd1' });
    const { user } = await (await get(TARGET)).json();

    expect(Object.keys(user).sort()).toEqual(
      ['_id', 'displayName', 'isPrivate', 'profileVisibility', 'username'].sort()
    );
    for (const leaked of ['bio', 'followersCount', 'followingCount', 'reviewCount',
      'createdAt', 'plan', 'contribution', 'ratingScale', 'isFollowing']) {
      expect(user[leaked]).toBeUndefined();
    }
  });

  test('no follow lookup happens for a stub — nothing to follow from here', async () => {
    mockUser();
    Discussion.exists.mockResolvedValue({ _id: 'd1' });
    await get(TARGET);
    expect(Follow.findOne).not.toHaveBeenCalled();
  });
});

describe('unchanged paths', () => {
  test('a public profile still returns the full payload', async () => {
    mockUser({ profileVisibility: 'public' });
    const res = await get(TARGET);
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user).toMatchObject({ username: 'boubou17', bio: 'a secret bio', followersCount: 3 });
    expect(user.isPrivate).toBeUndefined();
    // A public profile must not pay for the footprint checks.
    expect(Discussion.exists).not.toHaveBeenCalled();
  });

  test('the owner still sees their own private profile in full', async () => {
    mockUser();
    const res = await get(TARGET, TARGET);
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user.bio).toBe('a secret bio');
    expect(user.isPrivate).toBeUndefined();
    expect(Discussion.exists).not.toHaveBeenCalled();
  });

  test('a malformed id is still a 400', async () => {
    const res = await get('not-an-id');
    expect(res.status).toBe(400);
  });
});
