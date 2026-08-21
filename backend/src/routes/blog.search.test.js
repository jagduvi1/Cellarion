/**
 * Blog free-text search (user request 2026-08-21).
 *
 * A Mongo regex over 27 posts, not a Meilisearch index — the interesting part
 * is therefore not relevance but the two ways a user-supplied needle can hurt
 * you: `?q[$gt]=` arrives as an OBJECT and would throw on .trim(), and an
 * unescaped `(((((` is a ReDoS. Both are covered below because both are one
 * missing helper call away from being real.
 */
const express = require('express');
const http = require('http');

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));

const captured = { filter: null };
jest.mock('../models/BlogPost', () => {
  const chain = {
    sort: () => chain, skip: () => chain, limit: () => chain,
    populate: () => chain, select: () => Promise.resolve([]),
  };
  return {
    find: jest.fn((f) => { captured.filter = f; return chain; }),
    countDocuments: jest.fn(() => Promise.resolve(0)),
    aggregate: jest.fn(() => Promise.resolve([])),
  };
});

const app = express();
app.use(express.json());
app.use('/api/blog', require('./blog'));

beforeEach(() => { captured.filter = null; });

// The project has no supertest; the other route suites raise a real server on
// an ephemeral port, which also means the query string is parsed by Express
// exactly as it would be in production — the whole point of the `?q[$gt]=`
// case below.
function list(qs = '') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      http.get({ port: server.address().port, path: `/api/blog${qs}` }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

describe('GET /api/blog?q=', () => {
  it('searches title, excerpt and tags', async () => {
    await list('?q=maturity');
    expect(captured.filter.status).toBe('published');
    expect(captured.filter.$or).toHaveLength(3);
    const [title, excerpt, tags] = captured.filter.$or;
    expect(title.title).toBeInstanceOf(RegExp);
    expect(excerpt.excerpt).toBeInstanceOf(RegExp);
    // Tags are stored lowercased and matched EXACTLY, so searching "mcp"
    // finds tagged posts whose prose never says the word.
    expect(tags.tags).toBe('maturity');
  });

  it('lowercases only the tag arm, and matches text case-insensitively', async () => {
    await list('?q=MCP');
    const [title, , tags] = captured.filter.$or;
    expect(tags.tags).toBe('mcp');
    expect(title.title.flags).toContain('i');
  });

  it('ESCAPES regex metacharacters — an unescaped needle is a ReDoS', async () => {
    await list(`?q=${encodeURIComponent('(((((((((a')}`);
    const [{ title }] = captured.filter.$or;
    // Escaped, so it matches the literal text and cannot backtrack.
    expect(title.test('(((((((((a')).toBe(true);
    expect(title.test('aaaaaaaaaa')).toBe(false);
  });

  it('survives an OBJECT query param instead of 500-ing', async () => {
    // `?q[$gt]=` — Express yields { $gt: '' }, and .trim() on it throws.
    const res = await list('?q[$gt]=');
    expect(res.status).toBe(200);
    expect(captured.filter.$or).toBeUndefined();
  });

  it('ignores a blank or whitespace-only query rather than matching everything', async () => {
    await list('?q=%20%20');
    expect(captured.filter.$or).toBeUndefined();
  });

  it('bounds the needle', async () => {
    await list(`?q=${'x'.repeat(500)}`);
    const [{ title }] = captured.filter.$or;
    expect(title.source.length).toBeLessThanOrEqual(120);
  });

  it('combines with the existing tag filter instead of replacing it', async () => {
    await list('?q=drink&tag=mcp');
    expect(captured.filter.tags).toBe('mcp');
    expect(captured.filter.$or).toHaveLength(3);
  });

  it('never searches drafts', async () => {
    await list('?q=anything');
    expect(captured.filter.status).toBe('published');
  });
});
