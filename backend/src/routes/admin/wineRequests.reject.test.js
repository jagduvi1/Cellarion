/**
 * PUT /api/admin/wine-requests/:id/reject — bottle detachment (audit
 * 2026-08-03 H2).
 *
 * WHY THIS TEST EXISTS: import paths create bottles with `pendingWineRequest`
 * instead of `wineDefinition`. Resolve backfills them; reject used to flip
 * only the request's status, stranding every referencing bottle forever
 * (wineDefinition isn't user-updatable, so the only escape was delete-and-
 * re-add). This suite pins: reject unsets pendingWineRequest on the bottles,
 * reports the count (response + audit log), and keeps the response shape
 * backward-compatible.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineRequest', () => ({ findById: jest.fn() }));
jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn(), updateMany: jest.fn() }));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../../models/WineRequest');
const Bottle = require('../../models/Bottle');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const wineRequestsRouter = require('./wineRequests');

const ADMIN_ID = '64b000000000000000000001';
const REQUEST_ID = '64b000000000000000000002';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wine-requests', wineRequestsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

let requestDoc;
beforeEach(() => {
  jest.clearAllMocks();
  requestDoc = {
    _id: REQUEST_ID,
    status: 'pending',
    requestType: 'new_wine',
    wineName: 'Barolo del Comune',
    user: '64b000000000000000000003',
    save: jest.fn().mockResolvedValue({}),
    populate: jest.fn().mockResolvedValue({}),
  };
  WineRequest.findById.mockResolvedValue(requestDoc);
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

const reject = (body = { adminNotes: 'Not a real wine' }) =>
  fetch(`${baseUrl}/api/admin/wine-requests/${REQUEST_ID}/reject`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
    body: JSON.stringify(body),
  });

test('reject detaches every bottle pending this request (mirrors resolve backfill)', async () => {
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 3 });

  const res = await reject();
  expect(res.status).toBe(200);
  const data = await res.json();

  expect(Bottle.updateMany).toHaveBeenCalledWith(
    { pendingWineRequest: REQUEST_ID },
    { $unset: { pendingWineRequest: '' } }
  );
  expect(data.bottlesDetached).toBe(3);
  expect(requestDoc.status).toBe('rejected');
  expect(requestDoc.save).toHaveBeenCalled();

  // Audit log carries the affected-bottle count.
  const audit = logAudit.mock.calls.find((c) => c[1] === 'admin.request.reject');
  expect(audit[3]).toMatchObject({ bottlesDetached: 3 });

  // The user is told their bottles remain (editable, just unlinked).
  const [, , , message] = createNotification.mock.calls[0];
  expect(message).toContain('Not a real wine');
  expect(message).toContain('3 bottles');
});

test('response stays backward-compatible: wineRequest present, count additive, zero when nothing referenced', async () => {
  const res = await reject();
  const data = await res.json();

  expect(res.status).toBe(200);
  expect(data.wineRequest).toBeDefined();
  expect(data.bottlesDetached).toBe(0);
  // No bottle count in the notification when nothing was detached.
  const [, , , message] = createNotification.mock.calls[0];
  expect(message).not.toContain('bottle');
});

test('grape suggestions never touch bottles (no pendingWineRequest can reference them)', async () => {
  requestDoc.requestType = 'grape_suggestion';

  const res = await reject();
  expect(res.status).toBe(200);
  expect(Bottle.updateMany).not.toHaveBeenCalled();
});

test('a non-pending request is refused before any bottle is touched', async () => {
  requestDoc.status = 'rejected';

  const res = await reject();
  expect(res.status).toBe(400);
  expect(Bottle.updateMany).not.toHaveBeenCalled();
});

test('missing adminNotes is refused before any bottle is touched', async () => {
  const res = await reject({});
  expect(res.status).toBe(400);
  expect(Bottle.updateMany).not.toHaveBeenCalled();
});

test('a detach failure leaves the request PENDING so a retry re-runs the detach', async () => {
  // Ordering guard: were the status saved first, a detach failure would leave
  // the request rejected behind the not-pending 400 guard — re-stranding the
  // bottles permanently, the exact condition the detach exists to fix.
  Bottle.updateMany.mockRejectedValue(new Error('connection reset'));

  const res = await reject();
  expect(res.status).toBe(500);
  expect(requestDoc.save).not.toHaveBeenCalled();
  expect(requestDoc.status).toBe('pending'); // retryable — the $unset is idempotent
});
