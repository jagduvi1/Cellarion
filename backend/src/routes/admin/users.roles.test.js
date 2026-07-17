/**
 * PATCH /api/admin/users/:id/roles — role changes are credential events.
 *
 * WHY THIS TEST EXISTS (MCP Phase-4 audit MED-1): stateful MCP sessions freeze
 * the caller's roles at initialize, and cel_-token SSE streams carry claims
 * loaded at connect. Without a teardown signal, a demoted sommelier keeps the
 * somm tool surface warm until the session TTL (≤2h). The fix routes every
 * role change through eventBus.dropUser — SSE streams and MCP sessions die,
 * and clients transparently re-authenticate with fresh roles. This suite pins
 * that call (and that it does NOT fire on validation failures).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/User', () => ({ findById: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/eventBus', () => ({ dropUser: jest.fn(), dropToken: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const eventBus = require('../../services/eventBus');
const adminUsersRouter = require('./users');

const ADMIN_ID = '64b000000000000000000001';
const TARGET_ID = '64b000000000000000000002';

const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', adminUsersRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const patchRoles = (id, roles) => fetch(`${baseUrl}/api/admin/users/${id}/roles`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify({ roles }),
});

test('a successful role change drops the user\'s live push channels + MCP sessions', async () => {
  const target = {
    _id: TARGET_ID, username: 'x', email: 'x@example.com',
    roles: ['user', 'somm'], plan: 'free',
    save: jest.fn().mockResolvedValue({}),
  };
  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(target) });

  const res = await patchRoles(TARGET_ID, ['user']); // somm revoked
  expect(res.status).toBe(200);
  expect(target.save).toHaveBeenCalled();
  expect(eventBus.dropUser).toHaveBeenCalledWith(TARGET_ID);
});

test('validation failures change nothing and drop nothing', async () => {
  let res = await patchRoles(TARGET_ID, ['superhero']);
  expect(res.status).toBe(400);

  res = await patchRoles(ADMIN_ID, ['user']); // self-modification blocked
  expect(res.status).toBe(400);

  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
  res = await patchRoles(TARGET_ID, ['user']);
  expect(res.status).toBe(404);

  expect(eventBus.dropUser).not.toHaveBeenCalled();
});
