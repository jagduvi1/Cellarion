/**
 * GET /api/health — 200 while the process is serving, 503 while it is
 * shutting down (services/shutdown), so a deploy's health gate and the
 * container healthcheck read the process that is going as not ready (release
 * audit 2026-09-27, L: it answered 200 to the last).
 */
jest.mock('mongoose', () => ({ connection: { readyState: 1 } }));
jest.mock('../services/shutdown', () => ({ isDraining: jest.fn(() => false) }));

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { isDraining } = require('../services/shutdown');
const router = require('./health');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/health', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => { isDraining.mockReturnValue(false); mongoose.connection.readyState = 1; });

const get = () => fetch(`${baseUrl}/api/health`);

test('serving with the database connected: 200 ok, with the version', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', mongo: 'connected', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
});

test('database disconnected: 503 degraded', async () => {
  mongoose.connection.readyState = 0;
  const res = await get();
  expect(res.status).toBe(503);
  expect((await res.json()).status).toBe('degraded');
});

test('shutting down: 503 draining, even with the database connected', async () => {
  isDraining.mockReturnValue(true);
  const res = await get();
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: 'draining', mongo: 'connected' });
});
