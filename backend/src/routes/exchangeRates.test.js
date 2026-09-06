/**
 * GET /api/exchange-rates — the browser-facing twin of the daily snapshot
 * (audit 2026-09 F03-4). Pins: public, served from the snapshot, cacheable,
 * and a clean 503 (not a hang) when the upstream is unavailable.
 */

jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn() }));

const express = require('express');
const http = require('http');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const router = require('./exchangeRates');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/exchange-rates', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

test('serves the snapshot rates with a public cache header, no auth needed', async () => {
  getOrCreateDailySnapshot.mockResolvedValue({ date: '2026-09-06', fetchedAt: '2026-09-06T05:00:00.000Z', rates: { USD: 1, EUR: 0.92 } });
  const res = await fetch(`${baseUrl}/api/exchange-rates`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(await res.json()).toEqual({ base: 'USD', date: '2026-09-06', fetchedAt: '2026-09-06T05:00:00.000Z', rates: { USD: 1, EUR: 0.92 } });
});

test('answers 503 when no snapshot can be produced', async () => {
  getOrCreateDailySnapshot.mockResolvedValue(null);
  const res = await fetch(`${baseUrl}/api/exchange-rates`);
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/unavailable/);
});

test('answers 500 (not a hang) when the snapshot lookup throws', async () => {
  getOrCreateDailySnapshot.mockRejectedValue(new Error('db down'));
  const res = await fetch(`${baseUrl}/api/exchange-rates`);
  expect(res.status).toBe(500);
});
