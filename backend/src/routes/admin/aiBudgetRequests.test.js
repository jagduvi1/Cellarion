/**
 * /api/admin/ai-budget-requests — admin review of AI-budget increase requests.
 *
 * Approve writes a time-boxed aiBudgetOverride onto the requesting User
 * (grantedMax clamped 100–50000 default 2000, days clamped 1–30 default 7)
 * and notifies the requester; deny closes with a neutral notification. Both
 * audit. Query filters only ever contain literal status values / ObjectId
 * casts. Admin role required.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({
  createNotification: jest.fn(),
  createNotifications: jest.fn(),
}));
jest.mock('../../models/AiBudgetRequest', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/User', () => ({
  updateOne: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const AiBudgetRequest = require('../../models/AiBudgetRequest');
const User = require('../../models/User');
const { createNotification } = require('../../services/notifications');
const { logAudit } = require('../../services/audit');
const router = require('./aiBudgetRequests');

const ADMIN_ID = '64b0000000000000000000aa';
const REQUESTER = '64b000000000000000000001';
const REQ_ID = '64b0000000000000000000f1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ai-budget-requests', router);
  return app;
}

function request(app, { method, path, body, roles = ['admin'] }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json',
        authorization: `Bearer ${jwt.sign({ id: ADMIN_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
      };
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
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

// A pending request document with the instance methods the route uses.
function pendingDoc() {
  return {
    _id: REQ_ID,
    user: REQUESTER,
    reason: 'big import',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    grantedMax: null,
    grantedUntil: null,
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  };
}

function mockList(docs, total = docs.length) {
  const chain = {
    sort: () => chain, skip: () => chain, limit: () => chain,
    populate: () => chain, lean: async () => docs,
  };
  AiBudgetRequest.find.mockImplementation(() => chain);
  AiBudgetRequest.countDocuments.mockResolvedValue(total);
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  app = buildApp();
  User.updateOne.mockResolvedValue({ acknowledged: true });
});

describe('GET /api/admin/ai-budget-requests', () => {
  test('lists with a literal status filter (never raw request input)', async () => {
    mockList([{ _id: REQ_ID, status: 'pending' }], 1);

    const res = await request(app, { method: 'GET', path: '/api/admin/ai-budget-requests?status=pending' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(AiBudgetRequest.find).toHaveBeenCalledWith({ status: 'pending' });
  });

  test('status=decided maps to approved+denied; unknown status means no filter', async () => {
    mockList([]);
    await request(app, { method: 'GET', path: '/api/admin/ai-budget-requests?status=decided' });
    expect(AiBudgetRequest.find).toHaveBeenCalledWith({ status: { $in: ['approved', 'denied'] } });

    await request(app, { method: 'GET', path: '/api/admin/ai-budget-requests?status=%7B%22%24gt%22%3A%22%22%7D' });
    expect(AiBudgetRequest.find).toHaveBeenLastCalledWith({});
  });

  test('403 for non-admins', async () => {
    const res = await request(app, { method: 'GET', path: '/api/admin/ai-budget-requests', roles: ['user'] });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/admin/ai-budget-requests/:id — approve', () => {
  test('sets the user override, closes the request, notifies + audits', async () => {
    const doc = pendingDoc();
    AiBudgetRequest.findById.mockResolvedValue(doc);
    const before = Date.now();

    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve', grantedMax: 3000, days: 14 },
    });

    expect(res.status).toBe(200);

    // Override written onto the requesting user
    expect(User.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = User.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: REQUESTER });
    expect(update.$set.aiBudgetOverride.max).toBe(3000);
    const expiry = update.$set.aiBudgetOverride.expiresAt.getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 14 * 86400000 - 5000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 14 * 86400000 + 5000);

    // Request closed with the grant recorded
    expect(doc.status).toBe('approved');
    expect(doc.decidedBy).toBe(ADMIN_ID);
    expect(doc.grantedMax).toBe(3000);
    expect(doc.grantedUntil).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();

    // Requester notified with the new limit + expiry
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [uid, type, , message] = createNotification.mock.calls[0];
    expect(uid).toBe(REQUESTER);
    expect(type).toBe('ai_budget_approved');
    expect(message).toContain('3000');

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.aiBudget.approve',
      expect.objectContaining({ type: 'AiBudgetRequest' }),
      expect.objectContaining({ grantedMax: 3000, days: 14 })
    );
  });

  test('defaults: grantedMax 2000, 7 days', async () => {
    const doc = pendingDoc();
    AiBudgetRequest.findById.mockResolvedValue(doc);

    await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve' },
    });

    const override = User.updateOne.mock.calls[0][1].$set.aiBudgetOverride;
    expect(override.max).toBe(2000);
    const days = (override.expiresAt.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  test('clamps: grantedMax 100–50000, days 1–30', async () => {
    for (const [input, expected] of [
      [{ grantedMax: 5 }, 100],
      [{ grantedMax: 9999999 }, 50000],
      [{ grantedMax: 'evil' }, 2000],
    ]) {
      jest.clearAllMocks();
      User.updateOne.mockResolvedValue({});
      AiBudgetRequest.findById.mockResolvedValue(pendingDoc());
      await request(app, {
        method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
        body: { action: 'approve', ...input },
      });
      expect(User.updateOne.mock.calls[0][1].$set.aiBudgetOverride.max).toBe(expected);
    }

    jest.clearAllMocks();
    User.updateOne.mockResolvedValue({});
    AiBudgetRequest.findById.mockResolvedValue(pendingDoc());
    await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve', days: 365 },
    });
    const expiry = User.updateOne.mock.calls[0][1].$set.aiBudgetOverride.expiresAt.getTime();
    expect(expiry).toBeLessThanOrEqual(Date.now() + 30 * 86400000 + 5000);
  });
});

describe('PATCH /api/admin/ai-budget-requests/:id — deny', () => {
  test('closes the request without touching the user, neutral notification', async () => {
    const doc = pendingDoc();
    AiBudgetRequest.findById.mockResolvedValue(doc);

    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'deny' },
    });

    expect(res.status).toBe(200);
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(doc.status).toBe('denied');
    expect(doc.grantedMax).toBeNull();
    expect(doc.save).toHaveBeenCalled();

    const [uid, type] = createNotification.mock.calls[0];
    expect(uid).toBe(REQUESTER);
    expect(type).toBe('ai_budget_denied');

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.aiBudget.deny',
      expect.anything(), expect.anything()
    );
  });
});

describe('PATCH guards', () => {
  test('400 on invalid id', async () => {
    const res = await request(app, {
      method: 'PATCH', path: '/api/admin/ai-budget-requests/not-an-id',
      body: { action: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(AiBudgetRequest.findById).not.toHaveBeenCalled();
  });

  test('400 on unknown action', async () => {
    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'escalate' },
    });
    expect(res.status).toBe(400);
  });

  test('404 when the request does not exist', async () => {
    AiBudgetRequest.findById.mockResolvedValue(null);
    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve' },
    });
    expect(res.status).toBe(404);
  });

  test('400 when already decided — no second override, no second notification', async () => {
    const doc = { ...pendingDoc(), status: 'approved' };
    AiBudgetRequest.findById.mockResolvedValue(doc);
    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('403 for non-admins', async () => {
    const res = await request(app, {
      method: 'PATCH', path: `/api/admin/ai-budget-requests/${REQ_ID}`,
      body: { action: 'approve' }, roles: ['user'],
    });
    expect(res.status).toBe(403);
  });
});
