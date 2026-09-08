/**
 * /api/bridge/status and /api/bridge/adopt — the self-hosted side's own routes.
 *
 * WHY THIS TEST EXISTS:
 * Adopting a registry wine writes a local record on behalf of the signed-in
 * user, so the route must require a session, refuse demo accounts, map the
 * service's codes to honest statuses (an unreachable registry is a 503 with
 * a next step, not a 500), audit only the creations, and hand the picker a
 * normal local wine doc.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/rateLimits', () => ({ get: () => ({ auth: { max: 1000 }, api: { max: 1000 }, write: { max: 1000 } }) }));
jest.mock('../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  return { findOne: jest.fn(), hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'), TOKEN_PREFIX: 'cel_' };
});
jest.mock('../services/registryBridge', () => ({ status: jest.fn(), adoptWine: jest.fn(), setRefreshMode: jest.fn() }));
jest.mock('../utils/grapeDisplay', () => ({ decorateGrapes: (w) => ({ ...w, decorated: true }) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const bridge = require('../services/registryBridge');
const { logAudit } = require('../services/audit');
const router = require('./bridge');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/bridge', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const token = (claims = {}) => `Bearer ${jwt.sign({ id: 'u1', roles: ['user'], ...claims }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;
const call = (method, path, body, auth = token()) => fetch(`${baseUrl}${path}`, {
  method, headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const RID = 'a'.repeat(24);

describe('GET /api/bridge/status', () => {
  test('needs a session and returns the service status', async () => {
    expect((await call('GET', '/api/bridge/status', null, null)).status).toBe(401);
    bridge.status.mockResolvedValue({ enabled: true, held: 3 });
    const res = await call('GET', '/api/bridge/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, held: 3 });
  });
});

describe('POST /api/bridge/adopt', () => {
  test('a created copy is 201, audited, and returned decorated for the picker', async () => {
    bridge.adoptWine.mockResolvedValue({ ok: true, created: true, wine: { _id: 'l1', name: 'Salmos', producer: 'Torres', grapes: [] } });
    const res = await call('POST', '/api/bridge/adopt', { registryId: RID });
    expect(res.status).toBe(201);
    expect(bridge.adoptWine).toHaveBeenCalledWith(RID, 'u1');
    const body = await res.json();
    expect(body).toEqual({ wine: { _id: 'l1', name: 'Salmos', producer: 'Torres', grapes: [], decorated: true }, created: true });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.adopt_registry', { type: 'wine', id: 'l1' }, expect.objectContaining({ registryId: RID }));
  });

  test('an already-held wine is 200 and not audited again', async () => {
    bridge.adoptWine.mockResolvedValue({ ok: true, created: false, wine: { _id: 'l1', name: 'Salmos' } });
    const res = await call('POST', '/api/bridge/adopt', { registryId: RID });
    expect(res.status).toBe(200);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('service codes map to honest statuses', async () => {
    for (const [code, status] of [['disabled', 404], ['invalid', 400], ['not_found', 404], ['unavailable', 503]]) {
      bridge.adoptWine.mockResolvedValue({ ok: false, code });
      const res = await call('POST', '/api/bridge/adopt', { registryId: RID });
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
  });

  test('a demo account cannot adopt', async () => {
    const res = await call('POST', '/api/bridge/adopt', { registryId: RID }, token({ isDemo: true }));
    expect(res.status).toBe(403);
    expect(bridge.adoptWine).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/bridge/refresh', () => {
  const admin = () => token({ roles: ['admin'] });

  test('admins of this install only', async () => {
    expect((await call('PATCH', '/api/bridge/refresh', { mode: 'off' }, null)).status).toBe(401);
    expect((await call('PATCH', '/api/bridge/refresh', { mode: 'off' })).status).toBe(403);
    expect(bridge.setRefreshMode).not.toHaveBeenCalled();
  });

  test('stores the mode and audits it', async () => {
    bridge.setRefreshMode.mockResolvedValue({ ok: true, mode: 'off', source: 'settings' });
    const res = await call('PATCH', '/api/bridge/refresh', { mode: 'off' }, admin());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'off', source: 'settings' });
    expect(bridge.setRefreshMode).toHaveBeenCalledWith('off', 'u1');
    expect(logAudit.mock.calls.some((c) => c[1] === 'bridge.refresh_mode.update' && c[3].mode === 'off')).toBe(true);
  });

  test('a bad mode is 400, an .env override is 409 with the mode in force', async () => {
    bridge.setRefreshMode.mockResolvedValue({ ok: false, code: 'invalid' });
    expect((await call('PATCH', '/api/bridge/refresh', { mode: 'sometimes' }, admin())).status).toBe(400);
    bridge.setRefreshMode.mockResolvedValue({ ok: false, code: 'env_override', mode: 'off', source: 'env' });
    const res = await call('PATCH', '/api/bridge/refresh', { mode: 'weekly' }, admin());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'env_override', mode: 'off', source: 'env' });
    expect(logAudit.mock.calls.some((c) => c[1] === 'bridge.refresh_mode.update')).toBe(false);
  });
});
