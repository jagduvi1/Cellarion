/**
 * A session probe with no refresh cookie is not a write and not a refresh
 * attempt.
 *
 * The app sends POST /api/auth/refresh on every cold start to learn whether a
 * session exists. Signed-out visitors and crawlers that execute the app send
 * one per page view, and none of them can guess a token: there is nothing to
 * guess. Counted against the write limiter and the refresh limiters, a
 * crawler rendering public wine pages was answered 429 for most of its crawl
 * and left an audit row per hit (2026-10-27). Now the probe answers 401 and
 * is counted nowhere, while a refresh that carries a cookie is limited as
 * before.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cookieless-'.repeat(6);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'cookieless-meili-key-0123456789';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const http = require('http');
const rateLimitsConfig = require('./config/rateLimits');

let server;
let base;

beforeAll(() => {
  // A tiny write budget, so the test can tell a counted write from an
  // uncounted one; the API budget is lifted so only the write limiter speaks.
  rateLimitsConfig.set({ ...rateLimitsConfig.defaults, api: { max: 100000 }, write: { max: 3 } });
  const app = require('./app');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(() => {
  rateLimitsConfig.set(rateLimitsConfig.defaults);
  if (server) server.close();
});

const post = (path, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers });

test('a refresh with no cookie answers 401 every time, past every limiter\'s ceiling', async () => {
  // 30 per address is the refresh limiter's own bucket for cookieless
  // requests and 300 the per-address ceiling; 3 is this test's write budget.
  const statuses = new Set();
  for (let i = 0; i < 320; i++) {
    const res = await post('/api/auth/refresh');
    statuses.add(res.status);
    await res.text();
  }
  expect([...statuses]).toEqual([401]);
});

test('those probes did not spend the write budget, which real writes still do', async () => {
  // The budget of 3 is untouched after 320 probes: three writes pass the
  // limiter (and 404 as unknown routes), the fourth is refused by it.
  for (let i = 0; i < 3; i++) {
    const res = await post('/api/no-such-write');
    expect(res.status).toBe(404);
    await res.text();
  }
  const refused = await post('/api/no-such-write');
  expect(refused.status).toBe(429);
  expect((await refused.json()).error).toMatch(/write requests/);
});

test('a refresh that carries a cookie is still a counted write', async () => {
  // The budget is spent (previous test): a cookie-bearing refresh is refused
  // by the write limiter before the route could look the token up.
  const res = await post('/api/auth/refresh', { Cookie: 'refreshToken=not-a-real-token' });
  expect(res.status).toBe(429);
  expect((await res.json()).error).toMatch(/write requests/);
});
