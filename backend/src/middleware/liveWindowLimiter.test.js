/**
 * liveWindowLimiter — an express-rate-limit limiter whose window is read from
 * a function on every request.
 *
 * express-rate-limit takes windowMs once, when the limiter is built, so a
 * window an admin saves in the rate-limit settings only reaches requests if
 * the limiter is rebuilt when it changes. Pins: the window in force is the
 * one the function returns now; a changed window builds a new limiter (its
 * counters start from zero, as after a restart); an unchanged window keeps
 * the same limiter and its counts; max is still read per request; and the
 * rebuild does not trip express-rate-limit's "created in a request handler"
 * warning, which is meant for limiters thrown away after one request.
 */

const express = require('express');
const http = require('http');
const liveWindowLimiter = require('./liveWindowLimiter');

let windowMs;
let max;
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.post('/hit', liveWindowLimiter({
    windowMs: () => windowMs,
    max: () => max,
    keyGenerator: () => 'one-caller',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'limited' }),
  }), (req, res) => res.json({ ok: true }));
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

let consoleError;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

const hit = () => fetch(`${baseUrl}/hit`, { method: 'POST' });
const resetSeconds = (res) => Number(res.headers.get('ratelimit-reset'));

test('the window in force is the one configured now, and a changed window starts a new limiter', async () => {
  windowMs = 20_000;
  max = 1;

  const first = await hit();
  expect(first.status).toBe(200);
  expect(resetSeconds(first)).toBeGreaterThan(15);
  expect(resetSeconds(first)).toBeLessThanOrEqual(20);

  const second = await hit();
  expect(second.status).toBe(429);

  // An admin saves a longer window: the next request is counted by a limiter
  // built with it, starting from zero.
  windowMs = 40_000;
  const afterChange = await hit();
  expect(afterChange.status).toBe(200);
  expect(resetSeconds(afterChange)).toBeGreaterThan(35);
  expect(resetSeconds(afterChange)).toBeLessThanOrEqual(40);

  // The new limiter counts as usual.
  expect((await hit()).status).toBe(429);

  // Rebuilding mid-request is deliberate here, not the per-request misuse
  // express-rate-limit warns about.
  expect(consoleError).not.toHaveBeenCalled();
});

test('an unchanged window keeps the same limiter, so its counts carry on', async () => {
  windowMs = 25_000;
  max = 2;

  expect((await hit()).status).toBe(200);
  expect((await hit()).status).toBe(200);
  expect((await hit()).status).toBe(429);
  expect((await hit()).status).toBe(429);
});

test('max is read on every request, without a rebuild', async () => {
  windowMs = 30_000;
  max = 1;

  expect((await hit()).status).toBe(200);
  expect((await hit()).status).toBe(429);

  // Same window, higher max: the same limiter lets the caller through again
  // and keeps its count (this is the third request it has seen).
  max = 5;
  const res = await hit();
  expect(res.status).toBe(200);
  expect(res.headers.get('ratelimit-remaining')).toBe('2');
});
