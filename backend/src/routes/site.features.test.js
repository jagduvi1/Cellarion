/**
 * GET /api/site/features — the public list the app reads to decide which
 * screens to show (combined with the user's own "Try new features early").
 *
 * WHY THIS TEST EXISTS:
 * A feature switched off must not be visible at all (unfinished work stays
 * dark), and the answer carries only what the app needs — not the English
 * admin titles or the notification bookkeeping.
 */
const express = require('express');
const http = require('http');
const featureFlags = require('../config/featureFlags');
const siteRouter = require('./site');

function get(path) {
  const app = express();
  app.use('/api/site', siteRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      http.get({ port: server.address().port, path }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

afterEach(() => featureFlags.set({}));

test('a feature in beta is listed with its dates and forum thread, and nothing else', async () => {
  featureFlags.set({ vintagePage: { state: 'beta', betaAt: '2026-10-10T09:00:00.000Z', forumPath: '/community/discussions/vintage-page', betaNotifiedAt: '2026-10-10T09:00:00.000Z' } });
  const { status, headers, body } = await get('/api/site/features');
  expect(status).toBe(200);
  expect(headers['cache-control']).toBe('public, max-age=60');
  expect(body.features).toEqual([{
    key: 'vintagePage', state: 'beta', betaAt: '2026-10-10T09:00:00.000Z', releasedAt: null, forumPath: '/community/discussions/vintage-page',
  }]);
});

test('a feature switched off is left out entirely', async () => {
  featureFlags.set({ vintagePage: { state: 'off' } });
  const { body } = await get('/api/site/features');
  expect(body.features.find((f) => f.key === 'vintagePage')).toBeUndefined();
});
