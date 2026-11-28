/**
 * The JSON body limit in front of the rack routes.
 *
 * A wall's shape lists every box with its id, a zone lists its positions, and
 * an arrangement lists the old and the new slot of every bottle in the rack.
 * All three pass the app's 10 kb default long before the routes' own limits.
 * Behind that default a wall of some 120 boxes can be created but never
 * saved again (not even renamed: the edit form sends the boxes with every
 * save), and "Organize this rack" cannot apply a plan for 95 bottles. What
 * the routes accept must get past the body parser. The route tests mount
 * their own parser, so only this file sees the app's.
 *
 * Neither request carries a token: a body the parser accepts reaches the auth
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

const RACK = 'a'.repeat(24);
const oid = (n) => n.toString(16).padStart(24, '0');

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

test('the largest wall the route stores, sent as the edit form sends it, gets past the body parser', async () => {
  // 20 × 20 cells, one box each, every box with its id.
  const boxes = [];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) boxes.push({ x, y, w: 1, h: 1, kind: 'x', _id: oid(y * 20 + x), perSection: 6 });
  }
  const body = { name: 'Cellar wall', group: 'Basement', rows: 20, cols: 20, typeConfig: { boxes } };
  expect(JSON.stringify(body).length).toBeGreaterThan(10 * 1024);
  expect((await send('PUT', `/api/racks/${RACK}`, body)).status).toBe(401);
});

test('an arrangement of every slot a rack may have gets past the body parser', async () => {
  const entries = Array.from({ length: 10000 }, (_, i) => ({ position: i + 1, bottleId: oid(i) }));
  const res = await send('POST', `/api/racks/${RACK}/arrange/apply`, { target: entries, before: entries });
  expect(res.status).toBe(401);
});

test('a body past what any rack request needs is still refused', async () => {
  const res = await send('PUT', `/api/racks/${RACK}`, { name: 'x'.repeat(1300 * 1024) });
  expect(res.status).toBe(413);
});
