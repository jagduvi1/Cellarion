/**
 * The JSON body limit in front of the SuperAdmin → AI routes.
 *
 * A prompt save posts the whole prompt as JSON, and the longest cap
 * (PROMPT_MAX_LENGTHS) is past the app's 10 kb default body limit. A prompt
 * the route accepts must get past the body parser, or the save answers 413
 * while the page's counter says the prompt fits. Everything else keeps the
 * 10 kb default.
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
const { PROMPT_MAX_LENGTHS } = require('./config/constants');

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

const patch = (path, body) => fetch(`${base}${path}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a prompt at the longest cap, in multi-byte text, gets past the body parser', async () => {
  const longest = Math.max(...Object.values(PROMPT_MAX_LENGTHS));
  const prompt = 'é—'.repeat(Math.ceil(longest / 2)).slice(0, longest);
  const res = await patch('/api/superadmin/ai/enrichment-prompt', { prompt });
  expect(res.status).toBe(401);
});

test('other routes keep the 10 kb default', async () => {
  const res = await patch('/api/superadmin/announcement', { message: 'x'.repeat(11 * 1024) });
  expect(res.status).toBe(413);
});
