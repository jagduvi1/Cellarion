/**
 * H-5 — a pendingIdentity wine must never reach an ANONYMOUS reader.
 *
 * Two surfaces did, and neither had an auth check to strengthen — the reads are
 * meant to be public:
 *
 *   • discussions — optionalAuth, wine populated into the response, baked into
 *     the anonymously-searchable discussion Meili index, and rendered for
 *     CRAWLERS by routes/og.js.
 *   • wine lists — a published list is served by routes/wineListPublic.js with
 *     no auth at all.
 *
 * So the gate is at WRITE time, and it is ABSOLUTE — unlike the creator-aware
 * rule in services/wineVisibility. Attaching is the act of publishing, so not
 * even the pending row's own creator may do it. Fixing it at the write closes
 * every downstream read in one place.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Discussion', () => {
  function Discussion(data) {
    Object.assign(this, data);
    this._id = 'disc-1';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  }
  Discussion.updateOne = jest.fn();
  Discussion.findById = jest.fn();
  Discussion.find = jest.fn();
  Discussion.CATEGORIES = ['general', 'tasting-notes', 'cellar-management'];
  return Discussion;
});
jest.mock('../models/DiscussionReply', () => {
  function DiscussionReply(data) { Object.assign(this, data); this.save = jest.fn().mockResolvedValue(this); }
  return DiscussionReply;
});
jest.mock('../models/DiscussionWatch', () => ({ updateOne: jest.fn(() => ({ catch: jest.fn() })), find: jest.fn() }));
jest.mock('../models/DiscussionReaction', () => {
  const m = { find: jest.fn() };
  m.REACTION_KINDS = ['like'];
  return m;
});
jest.mock('../models/DiscussionRead', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/DiscussionReport', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn(), exists: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({ indexDiscussion: jest.fn(), removeDiscussion: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn(() => ({ catch: jest.fn() })), decrementCred: jest.fn(() => ({ catch: jest.fn() })) }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn(), createNotifications: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendDiscussionReplyEmail: jest.fn(), EMAIL_VERIFICATION_ENABLED: false }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');

const oid = (c) => c.repeat(24);
const ME = oid('1');
const PENDING_WINE = oid('a');
const token = jwt.sign({ id: ME, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/discussions', require('./discussions'));
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const User = require('../models/User');

beforeEach(() => {
  jest.clearAllMocks();
  // checkDiscussionBan runs first on every write path.
  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
});

const createDiscussion = (wineDefinition) => fetch(`${baseUrl}/api/discussions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'What is this bottle?',
    body: 'I cannot read the label at all, any ideas from the group?',
    category: 'general',
    wineDefinition,
  }),
});

describe('H-5 — POST /api/discussions refuses to attach a pending wine', () => {
  test('the existence check itself excludes pending rows', async () => {
    WineDefinition.exists.mockResolvedValue(null); // no visible wine with that id

    const res = await createDiscussion(PENDING_WINE);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Wine not found');
    expect(WineDefinition.exists).toHaveBeenCalledWith(expect.objectContaining({
      pendingIdentity: { $ne: true },
    }));
  });

  test('the gate is ABSOLUTE — the query has no creator escape hatch', async () => {
    WineDefinition.exists.mockResolvedValue(null);

    await createDiscussion(PENDING_WINE);

    const filter = WineDefinition.exists.mock.calls[0][0];
    // A creator-aware clause would show up as $or/createdBy. Publishing is
    // publishing: the creator must not be able to do it either.
    expect(filter.$or).toBeUndefined();
    expect(filter.createdBy).toBeUndefined();
    expect(filter.pendingIdentity).toEqual({ $ne: true });
  });

  test('an ordinary wine still attaches', async () => {
    WineDefinition.exists.mockResolvedValue({ _id: oid('b') });

    const res = await createDiscussion(oid('b'));

    expect(res.status).toBe(201);
  });

  test('a discussion with NO wine never queries the registry', async () => {
    const res = await createDiscussion(undefined);

    expect(res.status).toBe(201);
    expect(WineDefinition.exists).not.toHaveBeenCalled();
  });
});
