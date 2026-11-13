/**
 * A request body the JSON parser refuses never reaches the log.
 *
 * The body parser hands a body it could not parse back on the error (`body`),
 * and the parse error's message quotes a piece of it. The app's error handler
 * logs the error, so a truncated sign-in request put the member's password on
 * stdout, and a token request mislabelled as JSON put an app's client secret
 * and refresh token there. The log line keeps the method, path and status.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unparsed-body-'.repeat(5);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'unparsed-body-meili-0123456789';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const http = require('http');
const { logger } = require('./services/audit');

let server;
let base;
let logged;

beforeAll(() => {
  const app = require('./app');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}, 120000);

afterAll(() => {
  if (server) server.close();
});

beforeEach(() => {
  logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
});

const post = (path, body, type = 'application/json') => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': type },
  body,
});
const everythingLogged = () => JSON.stringify(logged.mock.calls, (key, value) => (
  value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value
));

test('a truncated sign-in body is refused, and the password in it is not logged', async () => {
  const res = await post('/api/auth/login', '{"username":"someone","password":"MARKER-PASSWORD-417');
  expect(res.status).toBe(400);
  expect(logged).toHaveBeenCalled();
  expect(everythingLogged()).not.toContain('MARKER-PASSWORD-417');
  const [fields, text] = logged.mock.calls[0];
  expect(text).toBe('Unhandled request error');
  expect(fields).toMatchObject({ method: 'POST', path: '/api/auth/login', status: 400 });
  expect(fields.err).toEqual({ type: 'SyntaxError', parser: 'entity.parse.failed', message: 'request body could not be parsed' });
});

test('a token request mislabelled as JSON is refused, and its secret and refresh token are not logged', async () => {
  const res = await post('/api/mcp/oauth/token',
    'grant_type=refresh_token&client_id=mcpc_x&client_secret=MARKER-SECRET-529&refresh_token=MARKER-REFRESH-613');
  expect(res.status).toBe(400);
  const all = everythingLogged();
  expect(all).not.toContain('MARKER-SECRET-529');
  expect(all).not.toContain('MARKER-REFRESH-613');
});

test('any other error is still logged as it was', async () => {
  const res = await post('/api/auth/login', JSON.stringify({ username: 'u', password: 'p' }).repeat(2000));
  expect(res.status).toBe(413);
  const [fields] = logged.mock.calls[0];
  expect(fields.err).toBeInstanceOf(Error);
  expect(fields.err.type).toBe('entity.too.large');
});
