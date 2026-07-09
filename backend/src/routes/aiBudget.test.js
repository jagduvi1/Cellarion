/**
 * /api/ai-budget — user-side AI-budget escalation flow.
 *
 * POST /request: creates ONE pending AiBudgetRequest per user (second POST →
 * 409, and the E11000 path from the partial unique index also → 409 so the
 * guarantee is race-safe), notifies all admins via the notification system,
 * and audits the mutation.
 *
 * GET /status: the importer banner's data source — effective daily max
 * (override-aware via the REAL aiBudget service), today's usage, the active
 * override, and whether a request is already pending.
 *
 * Real router + real requireAuth (HS256 test tokens) + real
 * getEffectiveDailyMax; models and the notification/audit services are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({
  createNotification: jest.fn(),
  createNotifications: jest.fn(),
}));

jest.mock('../models/AiBudgetRequest', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  exists: jest.fn(),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../models/AiUsage', () => ({
  findOne: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const AiBudgetRequest = require('../models/AiBudgetRequest');
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');
const { createNotifications } = require('../services/notifications');
const { logAudit } = require('../services/audit');
const rateLimitsConfig = require('../config/rateLimits');
const aiBudgetRouter = require('./aiBudget');

const USER_ID = '64b000000000000000000001';
const ADMIN_A = '64b0000000000000000000aa';
const ADMIN_B = '64b0000000000000000000ab';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai-budget', aiBudgetRouter);
  return app;
}

function request(app, { method, path, body, token }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
      if (token !== null) {
        headers.authorization = `Bearer ${token ?? jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`;
      }
      const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload ?? undefined);
    });
  });
}

// Chainable .select().lean() helper used by several queries in the router.
const selectLean = (doc) => ({ select: () => ({ lean: async () => doc }) });

// User.findById serves two lookups: the override check inside the REAL
// aiBudget service (select 'aiBudgetOverride') and the requester's username
// for the admin notification (select 'username') — one doc covers both.
function setUserDoc(doc) {
  User.findById.mockImplementation(() => selectLean(doc));
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  rateLimitsConfig.set({
    ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)),
    aiDailyBudget: { max: 500 },
  });
  app = buildApp();

  setUserDoc({ username: 'johan', aiBudgetOverride: null });
  User.find.mockImplementation(() => selectLean([{ _id: ADMIN_A }, { _id: ADMIN_B }]));
  AiBudgetRequest.findOne.mockImplementation(() => selectLean(null));
  AiBudgetRequest.exists.mockResolvedValue(null);
  AiBudgetRequest.create.mockImplementation(async (data) => ({
    _id: '64b0000000000000000000f1',
    status: 'pending',
    reason: data.reason,
    createdAt: new Date(),
  }));
  AiUsage.findOne.mockImplementation(() => selectLean(null));
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

describe('POST /api/ai-budget/request', () => {
  test('creates a pending request, notifies all admins, audits', async () => {
    const res = await request(app, {
      method: 'POST', path: '/api/ai-budget/request',
      body: { reason: 'Importing 1,500 bottles — 620 remaining', pendingRows: 620 },
    });

    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('pending');

    expect(AiBudgetRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'Importing 1,500 bottles — 620 remaining',
      requestedContext: { pendingRows: 620 },
    }));

    // Fan-out to EVERY admin, through the notification system
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const items = createNotifications.mock.calls[0][0];
    expect(items.map(i => i.userId)).toEqual([ADMIN_A, ADMIN_B]);
    for (const item of items) {
      expect(item.type).toBe('ai_budget_request');
      expect(item.link).toBe('/admin/ai-budget-requests');
      expect(item.message).toContain('johan');
    }

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'aiBudget.request.create',
      expect.objectContaining({ type: 'AiBudgetRequest' }),
      expect.objectContaining({ pendingRows: 620 })
    );
  });

  test('sanitizes the reason: HTML stripped, capped at 500 chars', async () => {
    await request(app, {
      method: 'POST', path: '/api/ai-budget/request',
      body: { reason: `<script>alert(1)</script>${'x'.repeat(600)}` },
    });
    const created = AiBudgetRequest.create.mock.calls[0][0];
    expect(created.reason).not.toContain('<script>');
    expect(created.reason.length).toBeLessThanOrEqual(500);
  });

  test('non-numeric pendingRows is stored as null, absurd values are clamped', async () => {
    await request(app, {
      method: 'POST', path: '/api/ai-budget/request',
      body: { reason: 'r', pendingRows: 'DROP TABLE' },
    });
    expect(AiBudgetRequest.create.mock.calls[0][0].requestedContext.pendingRows).toBeNull();

    await request(app, {
      method: 'POST', path: '/api/ai-budget/request',
      body: { reason: 'r', pendingRows: 99999999 },
    });
    expect(AiBudgetRequest.create.mock.calls[1][0].requestedContext.pendingRows).toBe(100000);
  });

  test('409 when a request is already pending — no create, no notification', async () => {
    AiBudgetRequest.findOne.mockImplementation(() => selectLean({ _id: 'existing' }));

    const res = await request(app, { method: 'POST', path: '/api/ai-budget/request', body: { reason: 'again' } });

    expect(res.status).toBe(409);
    expect(AiBudgetRequest.create).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  test('409 on the E11000 race (partial unique index caught the concurrent duplicate)', async () => {
    AiBudgetRequest.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const res = await request(app, { method: 'POST', path: '/api/ai-budget/request', body: { reason: 'race' } });

    expect(res.status).toBe(409);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  test('401 without a token', async () => {
    const res = await request(app, { method: 'POST', path: '/api/ai-budget/request', body: {}, token: null });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/ai-budget/status', () => {
  test('returns base limit, usage and pending flag', async () => {
    AiUsage.findOne.mockImplementation(() => selectLean({ count: 137 }));
    AiBudgetRequest.exists.mockResolvedValue({ _id: 'p1' });

    const res = await request(app, { method: 'GET', path: '/api/ai-budget/status' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dailyMax: 500,
      usedToday: 137,
      override: null,
      pendingRequest: true,
    });
  });

  test('an active override raises dailyMax and is surfaced', async () => {
    const expiresAt = new Date(Date.now() + 86400000);
    setUserDoc({ username: 'johan', aiBudgetOverride: { max: 2000, expiresAt } });

    const res = await request(app, { method: 'GET', path: '/api/ai-budget/status' });

    expect(res.status).toBe(200);
    expect(res.body.dailyMax).toBe(2000);
    expect(res.body.override).toEqual({ max: 2000, expiresAt: expiresAt.toISOString() });
    expect(res.body.pendingRequest).toBe(false);
  });

  test('an expired override is ignored', async () => {
    setUserDoc({ username: 'johan', aiBudgetOverride: { max: 2000, expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app, { method: 'GET', path: '/api/ai-budget/status' });

    expect(res.body.dailyMax).toBe(500);
    expect(res.body.override).toBeNull();
  });
});
