/**
 * GET /api/reviews/user/:userId — the review list on a member's profile.
 *
 * WHY THIS TEST EXISTS:
 * ReviewCard names the author, links to the author's profile and offers Edit
 * and Delete only when `review.author._id` is the viewer. The feed and the
 * wine's review lists populate the author; this list must too, or on a
 * member's own profile every review reads "Unknown", links nowhere and has no
 * Edit or Delete.
 *
 * Real router + real requireAuth (HS256 test tokens); models are mocked so no
 * MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/reviewAggregation', () => ({ updateWineCommunityRating: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn(), decrementCred: jest.fn() }));
jest.mock('../models/Follow', () => ({ find: jest.fn() }));
jest.mock('../models/ReviewVote', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Review', () => ({ find: jest.fn(), countDocuments: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const User = require('../models/User');
const reviewsRouter = require('./reviews');

const OWNER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const REVIEW_ID = '64b0000000000000000000aa';

function get(url, viewerId) {
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'GET',
          headers: { authorization: `Bearer ${jwt.sign({ id: viewerId, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

let populateCalls;
let filters;

beforeEach(() => {
  jest.clearAllMocks();
  populateCalls = [];
  filters = [];
  User.findById.mockReturnValue({ select: async () => ({ _id: OWNER_ID, profileVisibility: 'public' }) });
  ReviewVote.find.mockReturnValue({ select: async () => [] });
  Review.countDocuments.mockResolvedValue(1);
  const doc = {
    _id: REVIEW_ID,
    toObject: () => ({
      _id: REVIEW_ID,
      author: { _id: OWNER_ID, username: 'owner', displayName: 'Owner' },
      visibility: 'public',
      tasting: { overall: 'Long and fresh.' },
    }),
  };
  Review.find.mockImplementation((filter) => {
    filters.push(filter);
    const q = {
      sort: () => q,
      skip: () => q,
      limit: () => q,
      populate: (...args) => { populateCalls.push(args); return q; },
      then: (resolve, reject) => Promise.resolve([doc]).then(resolve, reject),
    };
    return q;
  });
});

describe('GET /api/reviews/user/:userId', () => {
  test('the profile list populates the author, as the feed and the wine lists do', async () => {
    const r = await get(`/api/reviews/user/${OWNER_ID}`, OWNER_ID);
    expect(r.status).toBe(200);
    const author = populateCalls.find(([path]) => path === 'author');
    expect(author).toBeDefined();
    expect(author[1].split(' ')).toEqual(expect.arrayContaining(['username', 'displayName']));
    expect(r.body.reviews[0].author._id).toBe(OWNER_ID);
  });

  test('the owner sees all their reviews; another member only the public ones', async () => {
    await get(`/api/reviews/user/${OWNER_ID}`, OWNER_ID);
    await get(`/api/reviews/user/${OWNER_ID}`, OTHER_ID);
    expect(filters[0]).toEqual({ author: OWNER_ID });
    expect(filters[1]).toEqual({ author: OWNER_ID, visibility: 'public' });
  });

  test('a failing query reaches the error handler instead of hanging the request', async () => {
    Review.countDocuments.mockRejectedValue(new Error('db down'));
    const app = express();
    app.use('/api/reviews', reviewsRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: 'handled' })); // eslint-disable-line no-unused-vars
    const r = await new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const req = http.request({
          port: server.address().port,
          path: `/api/reviews/user/${OWNER_ID}`,
          method: 'GET',
          headers: { authorization: `Bearer ${jwt.sign({ id: OWNER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end();
      });
    });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('handled');
  });
});
