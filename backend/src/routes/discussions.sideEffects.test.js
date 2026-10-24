/**
 * Creating a thread or a reply answers 201 once the post is saved.
 *
 * WHY THIS TEST EXISTS:
 * The post is stored by save(). Populating the author for the response,
 * resolving @mentions and looking up the replier's name all run after it.
 * If one of them failed inside the route's try, the author saw a 500 for a
 * post that WAS stored, and the natural retry created a second thread (or
 * reply). A failed side effect is logged; the response still carries the
 * post. A failed save is still a 500.
 */

process.env.JWT_SECRET = 'test-secret';

const OP_ID = 'c'.repeat(24);

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24), roles: ['user'] }; next(); },
  requireNonDemo: (_req, _res, next) => next(),
  optionalAuth: (_req, _res, next) => next(),
  requireModeratorOrAdmin: (_req, _res, next) => next(),
  isModerator: () => false,
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/notifications', () => ({
  createNotification: jest.fn(),
  createNotifications: jest.fn(async () => {}),
}));
jest.mock('../services/mailgun', () => ({ sendDiscussionReplyEmail: jest.fn(), EMAIL_VERIFICATION_ENABLED: false }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, indexDiscussion: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn(async () => {}), decrementCred: jest.fn(async () => {}) }));
jest.mock('../utils/mentionParser', () => ({ extractMentions: jest.fn(async () => []) }));
jest.mock('../models/ForumLanguage', () => ({ find: jest.fn(), findOne: jest.fn(), exists: jest.fn() }));

// The documents the route builds with `new`: each gets its own save/populate,
// which a test can make fail.
const mockDiscussionSave = jest.fn();
const mockDiscussionPopulate = jest.fn();
const mockReplySave = jest.fn();
const mockReplyPopulate = jest.fn();
jest.mock('../models/Discussion', () => {
  function Discussion(doc) {
    Object.assign(this, doc, { _id: 'd'.repeat(24), slug: 'a-thread' });
    this.save = mockDiscussionSave;
    this.populate = mockDiscussionPopulate;
  }
  Discussion.findOne = jest.fn();
  Discussion.updateOne = jest.fn();
  Discussion.CATEGORIES = ['tasting-notes', 'food-pairing', 'recommendations', 'cellar-tips', 'general'];
  return Discussion;
});
jest.mock('../models/DiscussionReply', () => {
  function DiscussionReply(doc) {
    Object.assign(this, doc, { _id: 'e'.repeat(24) });
    this.save = mockReplySave;
    this.populate = mockReplyPopulate;
  }
  DiscussionReply.findById = jest.fn();
  return DiscussionReply;
});
jest.mock('../models/DiscussionRead', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/DiscussionReaction', () => ({ find: jest.fn(), REACTION_KINDS: [] }));
jest.mock('../models/DiscussionWatch', () => ({ updateOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/DiscussionReport', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/BlogPost', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const Discussion = require('../models/Discussion');
const DiscussionWatch = require('../models/DiscussionWatch');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { createNotifications } = require('../services/notifications');
const { extractMentions } = require('../utils/mentionParser');
const router = require('./discussions');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/discussions', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

/** User.findById: the ban check finds no ban; the replier lookup answers `replierLookup()`. */
const users = (replierLookup) => User.findById.mockImplementation(() => ({
  select: (fields) => (fields === 'discussionBan' ? Promise.resolve(null) : replierLookup()),
}));

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockDiscussionSave.mockResolvedValue(undefined);
  mockDiscussionPopulate.mockResolvedValue(undefined);
  mockReplySave.mockResolvedValue(undefined);
  mockReplyPopulate.mockResolvedValue(undefined);
  extractMentions.mockResolvedValue([]);
  Discussion.updateOne.mockResolvedValue({});
  Discussion.findOne.mockResolvedValue({
    _id: 'd'.repeat(24), slug: 'a-thread', author: OP_ID, title: 'Barolo 2016 now?', isLocked: false,
  });
  DiscussionWatch.updateOne.mockResolvedValue({});
  DiscussionWatch.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  users(async () => ({ username: 'anna' }));
});
afterEach(() => errorSpy.mockRestore());

const post = (path, body) => fetch(`${baseUrl}/api/discussions${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const newThread = () => post('', { title: 'Barolo 2016 now?', body: 'Is it too early to open one?', category: 'general' });
const newReply = () => post('/a-thread/replies', { body: 'Give it two more years.' });

describe('creating a thread', () => {
  test('a failed author populate after the save still answers 201, saved once', async () => {
    mockDiscussionPopulate.mockRejectedValue(new Error('connection reset'));
    const res = await newThread();

    expect(res.status).toBe(201);
    expect((await res.json()).discussion.title).toBe('Barolo 2016 now?');
    expect(mockDiscussionSave).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled(); // the failure is logged, not swallowed
  });

  test('a failed mention lookup after the save still answers 201', async () => {
    extractMentions.mockRejectedValue(new Error('connection reset'));
    const res = await newThread();

    expect(res.status).toBe(201);
    expect(mockDiscussionSave).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'discussion.create', expect.anything(), expect.anything());
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a failed save is still a 500', async () => {
    mockDiscussionSave.mockRejectedValue(new Error('write conflict'));
    const res = await newThread();

    expect(res.status).toBe(500);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('creating a reply', () => {
  test("a failed lookup of the replier's name still answers 201, and the OP is told 'Someone' replied", async () => {
    users(() => Promise.reject(new Error('connection reset')));
    const res = await newReply();

    expect(res.status).toBe(201);
    expect((await res.json()).reply.body).toBe('Give it two more years.');
    expect(mockReplySave).toHaveBeenCalledTimes(1);
    const items = createNotifications.mock.calls[0][0];
    expect(items).toEqual([expect.objectContaining({ userId: OP_ID, message: 'Someone replied to "Barolo 2016 now?"' })]);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a failed populate after the save still answers 201 with the reply', async () => {
    mockReplyPopulate.mockRejectedValue(new Error('connection reset'));
    const res = await newReply();

    expect(res.status).toBe(201);
    expect((await res.json()).reply.body).toBe('Give it two more years.');
    expect(mockReplySave).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'discussion_reply.create', expect.anything(), expect.anything());
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a failed save is still a 500', async () => {
    mockReplySave.mockRejectedValue(new Error('write conflict'));
    const res = await newReply();

    expect(res.status).toBe(500);
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
