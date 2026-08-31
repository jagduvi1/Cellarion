/**
 * The English forum must include threads that predate the `language` field.
 *
 * WHY THIS TEST EXISTS (production regression, 2026-08-31):
 * v1.190.0 added Discussion.language with `default: 'en'` and the release notes
 * — and the PR — claimed "every existing thread is English with no migration".
 * That is false. A Mongoose default is applied when a document is CREATED; it
 * does not touch documents already in the collection. So `{ language: 'en' }`
 * matched none of the existing threads, and the English forum rendered EMPTY
 * on production. Caught by the post-deploy verification, ~2 minutes live, and
 * fixed by backfilling the rows.
 *
 * The backfill is done. This pins the query-level fix that makes it impossible
 * to recur from a restored snapshot, a bulk insert, or any write that bypasses
 * the schema: English matches a missing field as well as an explicit 'en'.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn(), createNotifications: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendDiscussionReplyEmail: jest.fn(), EMAIL_VERIFICATION_ENABLED: false }));
// Meilisearch off, so the list takes the MongoDB path this test is about.
jest.mock('../services/search', () => ({ getIsAvailable: () => false, indexDiscussion: jest.fn() }));
jest.mock('../models/ForumLanguage', () => ({ find: jest.fn(), findOne: jest.fn(), exists: jest.fn() }));

const mockFind = jest.fn();
jest.mock('../models/Discussion', () => {
  const M = { find: (...a) => mockFind(...a), countDocuments: jest.fn().mockResolvedValue(0), findOne: jest.fn() };
  M.CATEGORIES = ['tasting-notes', 'food-pairing', 'recommendations', 'cellar-tips', 'general'];
  return M;
});
jest.mock('../models/DiscussionReply', () => ({ find: jest.fn(), aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/DiscussionRead', () => ({ find: jest.fn().mockReturnValue({ lean: async () => [] }) }));
jest.mock('../models/DiscussionReaction', () => ({ find: jest.fn(), REACTION_KINDS: [] }));
jest.mock('../models/DiscussionWatch', () => ({ updateOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/DiscussionReport', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/BlogPost', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const router = require('./discussions');

const chain = (rows) => {
  const c = {
    populate: () => c, sort: () => c, skip: () => c, limit: () => c, lean: async () => rows,
    then: (res) => Promise.resolve(rows).then(res),
  };
  return c;
};

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

beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockReturnValue(chain([]));
});

/** The filter the route handed to Discussion.find for the list query. */
const listFilter = () => mockFind.mock.calls[0]?.[0];

describe('English includes threads written before language sections existed', () => {
  test('the default (no language param) matches BOTH "en" and a missing field', async () => {
    await fetch(`${baseUrl}/api/discussions`);
    expect(listFilter().language).toEqual({ $in: ['en', null] });
  });

  test('an explicit language=en does the same', async () => {
    await fetch(`${baseUrl}/api/discussions?language=en`);
    expect(listFilter().language).toEqual({ $in: ['en', null] });
  });

  test('another language matches only itself — a French list must not absorb legacy threads', async () => {
    const ForumLanguage = require('../models/ForumLanguage');
    ForumLanguage.exists.mockResolvedValue({ _id: 'x' });
    await fetch(`${baseUrl}/api/discussions?language=fr`);
    expect(listFilter().language).toEqual({ $eq: 'fr' });
  });

  test('language=all applies no language filter at all', async () => {
    await fetch(`${baseUrl}/api/discussions?language=all`);
    expect(listFilter().language).toBeUndefined();
  });
});
