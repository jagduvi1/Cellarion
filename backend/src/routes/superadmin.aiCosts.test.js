/**
 * SuperAdmin → AI: the prompt-caching switch and the AI cost table
 * (2026-09-25).
 *
 * PATCH /api/superadmin/ai/prompt-caching is the instant way back from the
 * cached prompt layout — it must persist, apply immediately, and accept only a
 * boolean. GET /api/superadmin/ai/costs serves the spend ledger's summary.
 *
 * Auth middleware is stubbed to a signed-in superadmin (the real gate has its
 * own suite, middleware/superAdmin.test.js); the router's heavy services are
 * stubbed since these two routes never touch them.
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'admin-1', roles: ['admin'] }; next(); },
}));
jest.mock('../middleware/superAdmin', () => ({ requireSuperAdmin: (req, res, next) => next() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../services/embeddingJob', () => ({}));
jest.mock('../services/enrichmentJob', () => ({}));
jest.mock('../services/vectorStore', () => ({}));
jest.mock('../services/aiChat', () => ({ getEventLog: () => [] }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));
jest.mock('../services/aiCostLedger', () => ({ summarizeCosts: jest.fn() }));

const express = require('express');
const http = require('http');
const aiConfig = require('../config/aiConfig');
const { updateSiteConfig } = require('../utils/siteConfig');
const { summarizeCosts } = require('../services/aiCostLedger');
const superadminRouter = require('./superadmin');

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', superadminRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  updateSiteConfig.mockResolvedValue(undefined);
  aiConfig.set({});
});

describe('PATCH /api/superadmin/ai/prompt-caching', () => {
  test('caching is on by default', () => {
    expect(aiConfig.getRaw().promptCaching).toBe(true);
  });

  test('switching it off persists and applies immediately, keeping every other setting', async () => {
    aiConfig.set({ labelScanModel: 'claude-sonnet-5', chatDailyLimit: 42 });
    const res = await call('PATCH', '/api/superadmin/ai/prompt-caching', { enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promptCaching: false });
    expect(aiConfig.getRaw().promptCaching).toBe(false);
    expect(aiConfig.getRaw().chatDailyLimit).toBe(42);
    expect(updateSiteConfig).toHaveBeenCalledWith(
      'aiConfig',
      expect.objectContaining({ promptCaching: false, chatDailyLimit: 42 }),
      'admin-1'
    );
  });

  test.each([['yes'], [1], [null]])('rejects a non-boolean (%p) without saving', async (value) => {
    const res = await call('PATCH', '/api/superadmin/ai/prompt-caching', { enabled: value });
    expect(res.status).toBe(400);
    expect(updateSiteConfig).not.toHaveBeenCalled();
    expect(aiConfig.getRaw().promptCaching).toBe(true);
  });

  test('a failed save reports 500 and leaves the switch as it was', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    updateSiteConfig.mockRejectedValue(new Error('mongo down'));
    const res = await call('PATCH', '/api/superadmin/ai/prompt-caching', { enabled: false });
    expect(res.status).toBe(500);
    expect(aiConfig.getRaw().promptCaching).toBe(true);
    err.mockRestore();
  });
});

describe('GET /api/superadmin/ai/costs', () => {
  test('serves the ledger summary for the requested window', async () => {
    summarizeCosts.mockResolvedValue({ days: 7, features: [], daily: [], total: { usd: 0 } });
    const res = await call('GET', '/api/superadmin/ai/costs?days=7');
    expect(res.status).toBe(200);
    expect(summarizeCosts).toHaveBeenCalledWith({ days: 7 });
    expect(res.body.days).toBe(7);
  });

  test('defaults to 30 days when the window is missing or junk', async () => {
    summarizeCosts.mockResolvedValue({ days: 30 });
    await call('GET', '/api/superadmin/ai/costs?days=abc');
    expect(summarizeCosts).toHaveBeenCalledWith({ days: 30 });
  });

  test('a ledger failure is a 500, not a crash', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    summarizeCosts.mockRejectedValue(new Error('mongo down'));
    const res = await call('GET', '/api/superadmin/ai/costs');
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
