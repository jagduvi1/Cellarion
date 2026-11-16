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

jest.mock('../services/audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('../config/rateLimits', () => ({ get: () => ({ auth: { max: 1000 }, api: { max: 1000 }, write: { max: 1000 } }) }));
jest.mock('../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  return { findOne: jest.fn(), hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'), TOKEN_PREFIX: 'cel_' };
});
jest.mock('../services/registryBridge', () => ({ status: jest.fn(), adoptWine: jest.fn(), setRefreshMode: jest.fn(), isEnabled: jest.fn(() => true) }));
jest.mock('../utils/grapeDisplay', () => ({ decorateGrapes: (w) => ({ ...w, decorated: true }) }));
jest.mock('../services/registryContributionOps', () => ({
  queueContributions: jest.fn(), sendQueued: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }), withdrawContribution: jest.fn(),
  contributionForWine: jest.fn(), contributionOverview: jest.fn(), QUEUE_MAX: 500,
}));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const bridge = require('../services/registryBridge');
const { logAudit } = require('../services/audit');
const contributions = require('../services/registryContributionOps');
const { findVisibleWine } = require('../services/wineVisibility');
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
beforeEach(() => { jest.clearAllMocks(); bridge.isEnabled.mockReturnValue(true); });

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

describe('POST /api/bridge/adopt — the answer about the copy', () => {
  test('never carries the sweetness style, whether the copy was loaded with it or not', async () => {
    for (const sweetnessStyle of [null, { term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: 'https://merchant.example/x' }]) {
      bridge.adoptWine.mockResolvedValue({ ok: true, created: false, wine: { _id: 'l1', name: 'Salmos', producer: 'Torres', grapes: [], sweetnessStyle } });
      const res = await call('POST', '/api/bridge/adopt', { registryId: RID });
      expect(res.status).toBe(200);
      expect((await res.json()).wine).not.toHaveProperty('sweetnessStyle');
    }
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

describe('contributions — offering wines made on this install', () => {
  const admin = () => token({ roles: ['admin'] });
  const WINE = 'b'.repeat(24);

  test('offering, taking back and the overview are for admins of this install; demo accounts never', async () => {
    expect((await call('POST', '/api/bridge/contributions', { wineIds: [WINE] })).status).toBe(403);
    expect((await call('DELETE', `/api/bridge/contributions/${WINE}`)).status).toBe(403);
    expect((await call('GET', '/api/bridge/contributions')).status).toBe(403);
    expect((await call('POST', '/api/bridge/contributions', { all: true }, token({ roles: ['admin'], isDemo: true }))).status).toBe(403);
    expect((await call('POST', '/api/bridge/contributions', { all: true }, null)).status).toBe(401);
    expect(contributions.queueContributions).not.toHaveBeenCalled();
  });

  test('one wine is queued and sent at once, and its state comes back for the page', async () => {
    contributions.queueContributions.mockResolvedValue({ ok: true, queued: 1, ids: [WINE] });
    contributions.contributionForWine.mockResolvedValue({ enabled: true, linked: false, offerable: false, contribution: { status: 'sent' } });
    const res = await call('POST', '/api/bridge/contributions', { wineIds: [WINE] }, admin());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 1, wine: { enabled: true, linked: false, offerable: false, contribution: { status: 'sent' } } });
    expect(contributions.queueContributions).toHaveBeenCalledWith(expect.objectContaining({ wineIds: [WINE], all: false, via: 'web' }));
    expect(contributions.sendQueued).toHaveBeenCalledWith({ max: 1, ids: [WINE] });
  });

  test('"all" queues and answers at once; the sending runs on after the answer', async () => {
    contributions.queueContributions.mockResolvedValue({ ok: true, queued: 60, ids: [] });
    const res = await call('POST', '/api/bridge/contributions', { all: true }, admin());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 60 });
    expect(contributions.queueContributions).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
    expect(contributions.sendQueued).toHaveBeenCalledWith();
  });

  test('not connected is a 404 with the reason; a bad list is a 400; nothing queued sends nothing', async () => {
    contributions.queueContributions.mockResolvedValue({ ok: false, code: 'disabled' });
    const notConnected = await call('POST', '/api/bridge/contributions', { all: true }, admin());
    expect(notConnected.status).toBe(404);
    expect(await notConnected.json()).toMatchObject({ code: 'bridge_not_connected' });
    contributions.queueContributions.mockResolvedValue({ ok: false, code: 'invalid' });
    const badList = await call('POST', '/api/bridge/contributions', { wineIds: ['x'] }, admin());
    expect(badList.status).toBe(400);
    expect(await badList.json()).toMatchObject({ code: 'contribution_wine_ids_invalid', max: 500 });
    contributions.queueContributions.mockResolvedValue({ ok: true, queued: 0, ids: [] });
    expect((await call('POST', '/api/bridge/contributions', { all: true }, admin())).status).toBe(200);
    expect(contributions.sendQueued).not.toHaveBeenCalled();
  });

  test("a wine's state is readable by any member who can see the wine, and only then", async () => {
    findVisibleWine.mockResolvedValue(null);
    expect((await call('GET', `/api/bridge/contributions/${WINE}`)).status).toBe(404);
    expect(contributions.contributionForWine).not.toHaveBeenCalled();
    findVisibleWine.mockResolvedValue({ _id: WINE });
    contributions.contributionForWine.mockResolvedValue({ enabled: true, linked: false, offerable: true, contribution: null });
    const res = await call('GET', `/api/bridge/contributions/${WINE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, linked: false, offerable: true, contribution: null });
    expect(findVisibleWine).toHaveBeenCalledWith(WINE, expect.objectContaining({ userId: 'u1', roles: ['user'] }));
    expect((await call('GET', '/api/bridge/contributions/nope')).status).toBe(400);
  });

  test('taking back maps the service codes: a sent offer is a 409, one never offered a 404', async () => {
    contributions.withdrawContribution.mockResolvedValue({ ok: false, code: 'sent' });
    const sent = await call('DELETE', `/api/bridge/contributions/${WINE}`, null, admin());
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ code: 'contribution_already_sent' });
    contributions.withdrawContribution.mockResolvedValue({ ok: false, code: 'not_found' });
    const none = await call('DELETE', `/api/bridge/contributions/${WINE}`, null, admin());
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: 'contribution_not_offered' });
    contributions.withdrawContribution.mockResolvedValue({ ok: true });
    expect((await call('DELETE', `/api/bridge/contributions/${WINE}`, null, admin())).status).toBe(200);
  });
});

test('an install that is not connected answers a wine page at once, without looking the wine up', async () => {
  bridge.isEnabled.mockReturnValue(false);
  const res = await call('GET', `/api/bridge/contributions/${'b'.repeat(24)}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: false });
  expect(findVisibleWine).not.toHaveBeenCalled();
});
