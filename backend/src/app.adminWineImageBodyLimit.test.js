/**
 * The JSON body limit in front of POST /api/admin/wines/:id/image.
 *
 * The route sets a wine's official picture from image_base64, so its body is
 * a whole photo — far past the app's 10 kb default. A photo within the budget
 * of the route's MCP twin (admin_add_registry_wine, MAX_BASE64_CHARS = 1.5M
 * characters) must get past the body parser; the rest of /api/admin/wines
 * keeps the 10 kb default.
 *
 * No request carries a token: a body the parser accepts reaches the auth
 * gate (401); a body it refuses never gets that far (413).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'body-limit-'.repeat(6);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'body-limit-meili-key-0123456789';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const http = require('http');

const WINE_ID = 'a'.repeat(24);
// mcp/tools/adminRegistry.js MAX_BASE64_CHARS — the twin's budget.
const MCP_MAX_BASE64_CHARS = 1_500_000;

let server;
let base;

beforeAll(() => {
  const app = require('./app');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(() => {
  if (server) server.close();
});

const send = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a photo at the MCP twin\'s budget gets past the body parser', async () => {
  const res = await send('POST', `/api/admin/wines/${WINE_ID}/image`, {
    image_base64: `data:image/webp;base64,${'A'.repeat(MCP_MAX_BASE64_CHARS)}`,
    credit: 'Photo: the producer',
  });
  expect(res.status).toBe(401);
});

test('an ordinary label photo (~40 kB) gets past the body parser', async () => {
  const res = await send('POST', `/api/admin/wines/${WINE_ID}/image`, { image_base64: 'A'.repeat(40 * 1024) });
  expect(res.status).toBe(401);
});

test('a body past the budget is still refused', async () => {
  const res = await send('POST', `/api/admin/wines/${WINE_ID}/image`, { image_base64: 'A'.repeat(2 * 1024 * 1024 + 1) });
  expect(res.status).toBe(413);
});

test('the rest of /api/admin/wines keeps the 10 kb default', async () => {
  const res = await send('PUT', `/api/admin/wines/${WINE_ID}`, { name: 'x'.repeat(11 * 1024) });
  expect(res.status).toBe(413);
});

test('a longer path ending in /image is not given the larger budget', async () => {
  const res = await send('POST', `/api/admin/wines/${WINE_ID}/extra/image`, { image_base64: 'A'.repeat(11 * 1024) });
  expect(res.status).toBe(413);
});
