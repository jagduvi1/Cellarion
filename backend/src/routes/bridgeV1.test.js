/**
 * /api/bridge/v1 — the Registry Bridge protocol (REGISTRY_LOCKDOWN_PLAN §6).
 *
 * WHY THIS TEST EXISTS:
 * This router is the one surface through which registry data reaches a
 * self-hosted install, so its shape IS the lockdown: search returns identities
 * only and never a canary or a pending row; a wine fetch is counted under the
 * key and a canary fetch alerts the admins; a change check answers only about
 * the ids the install sent; contributions land in the same intake services
 * the hosted site uses, attributed to the key; every route spends its quota.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/photoState', () => ({ absoluteImageUrl: (p) => (p ? `https://api.test${p}` : null) }));
jest.mock('../services/registryReadTracker', () => ({ recordRead: jest.fn().mockResolvedValue({ distinct: 1 }) }));
jest.mock('../services/registryDataOps', () => ({ dataForWine: jest.fn(), suggestValue: jest.fn() }));
jest.mock('../services/wineProposalOps', () => ({ createFieldCorrection: jest.fn() }));
jest.mock('../services/accountOps', () => ({ createWineRequest: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotifications: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/clientIp', () => ({ rateLimitKey: (req) => req.ip || '127.0.0.1' }));
jest.mock('../config/legal', () => ({ CURRENT_REGISTRY_TERMS_VERSION: '2026-09' }));
// The key middleware and the quota are unit-tested on their own; here they are
// stand-ins that inject an owner and spend nothing, unless a test flips them.
jest.mock('../middleware/bridgeKeyAuth', () => ({
  requireBridgeKey: jest.fn((req, res, next) => {
    if (req.headers['x-test-key'] !== 'good') return res.status(401).json({ code: 'no_key' });
    req.user = { id: 'u1', roles: ['user'] };
    req.bridge = { key: { id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org' }, keyDoc: { _id: 'k1', user: 'u1', createdAt: new Date(), termsVersion: '2026-09' } };
    next();
  }),
}));
// Quota kinds are wired at require time; jest.clearAllMocks in beforeEach would
// wipe the mock's call list, so they are also recorded on a plain array.
global.__bridgeQuotaKinds = [];
jest.mock('../services/bridgeQuota', () => ({
  quota: jest.fn((kind) => { global.__bridgeQuotaKinds.push(kind); return (req, res, next) => next(); }),
  usageFor: jest.fn().mockResolvedValue({ day: '2026-09-08', used: {}, caps: {} }),
  QUOTAS: { searches: 600, fetches: 300, changeChecks: 1, contributions: 50 },
  capsNow: () => ({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50 }),
}));

const express = require('express');
const http = require('http');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const User = require('../models/User');
const searchService = require('../services/search');
const { findVisibleWine } = require('../services/wineVisibility');
const { recordRead } = require('../services/registryReadTracker');
const { dataForWine, suggestValue } = require('../services/registryDataOps');
const { createFieldCorrection } = require('../services/wineProposalOps');
const { createWineRequest } = require('../services/accountOps');
const { createNotifications } = require('../services/notifications');
const { logAudit } = require('../services/audit');
const { quota } = require('../services/bridgeQuota');
const router = require('./bridgeV1');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  // Same body budget app.js gives the router (a 5,000-id change check).
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/bridge/v1', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const call = (method, path, body, key = 'good') => fetch(`${baseUrl}${path}`, {
  method, headers: { 'x-test-key': key, 'Content-Type': 'application/json' },
  body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
});
const chain = (result) => {
  const c = {};
  for (const m of ['select', 'populate', 'sort', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};
const ID = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);
const wine = (over = {}) => ({
  _id: ID, name: 'Salmos', producer: 'Torres', slug: 'torres-salmos', type: 'red', appellation: 'Priorat',
  region: { name: 'Catalonia' }, country: { name: 'Spain' }, grapes: [{ name: 'Cariñena' }, { name: 'Syrah' }],
  image: '/api/uploads/processed/x.png', imageCredit: 'Estate', updatedAt: new Date('2026-09-01'),
  aiProfile: { body: 'full', tannin: 'high', acidity: 'medium', sweetness: 'dry', flavors: ['plum'], foodPairings: ['lamb'], description: 'A dense Priorat.', source: 'curator', generatedAt: new Date(), heldAt: null, producerNote: 'internal', inputsSnapshot: { x: 1 }, model: 'm' },
  ...over,
});

describe('auth and quota wiring', () => {
  test('every route sits behind the key middleware', async () => {
    for (const [m, p] of [['GET', '/api/bridge/v1/me'], ['GET', '/api/bridge/v1/search?q=salmos'], ['GET', `/api/bridge/v1/wines/${ID}`], ['POST', '/api/bridge/v1/wines/changes'], ['POST', '/api/bridge/v1/requests'], ['POST', '/api/bridge/v1/corrections'], ['POST', '/api/bridge/v1/values']]) {
      expect((await call(m, p, {}, 'bad')).status).toBe(401);
    }
  });

  test('each data route spends its own quota kind', () => {
    const kinds = global.__bridgeQuotaKinds;
    expect(quota).toBeDefined();
    expect(kinds).toEqual(expect.arrayContaining(['searches', 'fetches', 'changeChecks', 'contributions']));
    expect(kinds.filter((k) => k === 'contributions')).toHaveLength(3);
  });

  test('GET /me reports the key, the quotas and the terms version', async () => {
    const body = await (await call('GET', '/api/bridge/v1/me')).json();
    expect(body).toMatchObject({ key: { id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678' }, terms: { version: '2026-09', current: '2026-09' }, quotas: { fetches: 300 }, burstPerMinute: 60, protocol: 'v1' });
  });
});

describe('GET /search', () => {
  test('returns identities only — no profile — and excludes canary, non-wine and pending rows (Mongo fallback)', async () => {
    WineDefinition.find.mockReturnValue(chain([wine()]));
    const res = await call('GET', '/api/bridge/v1/search?q=salmos');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines[0]).toEqual({
      id: ID, slug: 'torres-salmos', producer: 'Torres', name: 'Salmos', type: 'red', appellation: 'Priorat', classification: null,
      region: 'Catalonia', country: 'Spain', grapes: ['Cariñena', 'Syrah'], image: 'https://api.test/api/uploads/processed/x.png', imageCredit: 'Estate',
    });
    expect(body.wines[0]).not.toHaveProperty('profile');
    expect(body.wines[0]).not.toHaveProperty('aiProfile');
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter).toMatchObject({ nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true }, $text: { $search: 'salmos' } });
    expect(WineDefinition.find.mock.results[0].value.limit).toHaveBeenCalledWith(10);
  });

  test('uses Meilisearch when available, keeping its ranking and the same visibility filter', async () => {
    searchService.getIsAvailable.mockReturnValue(true);
    searchService.search.mockResolvedValue({ ids: [ID2, ID] });
    WineDefinition.find.mockReturnValue(chain([wine(), wine({ _id: ID2, name: 'Salmos Reserva' })]));
    const body = await (await call('GET', '/api/bridge/v1/search?q=salmos')).json();
    expect(searchService.search).toHaveBeenCalledWith('salmos', { limit: 10 });
    expect(WineDefinition.find.mock.calls[0][0]).toMatchObject({ _id: { $in: [ID2, ID] }, canary: { $ne: true } });
    expect(body.wines.map((w) => w.id)).toEqual([ID2, ID]);
    searchService.getIsAvailable.mockReturnValue(false);
  });

  test('a query shorter than 2 characters is a 400', async () => {
    expect((await call('GET', '/api/bridge/v1/search?q=a')).status).toBe(400);
  });
});

describe('GET /wines/:id', () => {
  test('one wine in full: identity, the registry profile fields only, reviewed windows, published values — and a counted read', async () => {
    findVisibleWine.mockResolvedValue(wine());
    WineVintageProfile.find.mockReturnValue(chain([{ vintage: '2019', relative: false, earlyFrom: 2022, earlyUntil: 2023, peakFrom: 2024, peakUntil: 2030, lateFrom: 2031, lateUntil: 2034 }]));
    dataForWine.mockResolvedValue({ ok: true, fields: [{ key: { name: 'ABV', unit: '%' }, value: 14.5, wineValue: 14.5, overrides: [], contributedBy: 'anna' }, { key: { name: 'Closure' }, value: null }] });
    const res = await call('GET', `/api/bridge/v1/wines/${ID}`);
    expect(res.status).toBe(200);
    const { wine: w } = await res.json();
    expect(findVisibleWine).toHaveBeenCalledWith(ID, expect.objectContaining({ userId: null, roles: [], lean: true }));
    expect(w).toMatchObject({ id: ID, producer: 'Torres', name: 'Salmos', region: 'Catalonia', profile: { body: 'full', description: 'A dense Priorat.', source: 'curator' } });
    expect(w.profile).not.toHaveProperty('producerNote');
    expect(w.profile).not.toHaveProperty('inputsSnapshot');
    expect(w.profile).not.toHaveProperty('model');
    expect(w.windows).toEqual([{ vintage: '2019', relative: false, early: { from: 2022, until: 2023 }, peak: { from: 2024, until: 2030 }, late: { from: 2031, until: 2034 } }]);
    expect(WineVintageProfile.find).toHaveBeenCalledWith({ wineDefinition: ID, status: 'reviewed' });
    expect(w.values).toEqual([{ key: { name: 'ABV', unit: '%' }, value: 14.5, wineValue: 14.5, overrides: [] }]);
    expect(JSON.stringify(w.values)).not.toContain('anna');
    expect(recordRead).toHaveBeenCalledWith({ key: 'key:k1', kind: 'key' }, ID);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  test('a canary fetched through a key is served, audited and reported to the admins at once', async () => {
    findVisibleWine.mockResolvedValue(wine({ canary: true }));
    WineVintageProfile.find.mockReturnValue(chain([]));
    dataForWine.mockResolvedValue({ ok: true, fields: [] });
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'admin1' }]) }) });
    const res = await call('GET', `/api/bridge/v1/wines/${ID}`);
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bridge.canary_hit', { type: 'wine', id: ID }, expect.objectContaining({ key: 'k1', instanceHost: 'cellar.example.org' }));
    expect(createNotifications).toHaveBeenCalledWith([expect.objectContaining({ userId: 'admin1', type: 'registry_read_alert', message: expect.stringContaining('Home NAS') })]);
    const body = await res.json();
    expect(body.wine).not.toHaveProperty('canary');
  });

  test('hidden or non-wine rows are 404; a bad id is 400', async () => {
    findVisibleWine.mockResolvedValue(null);
    expect((await call('GET', `/api/bridge/v1/wines/${ID}`)).status).toBe(404);
    findVisibleWine.mockResolvedValue(wine({ nonWine: true }));
    expect((await call('GET', `/api/bridge/v1/wines/${ID}`)).status).toBe(404);
    expect((await call('GET', '/api/bridge/v1/wines/nope')).status).toBe(400);
    expect(recordRead).not.toHaveBeenCalled();
  });
});

describe('POST /wines/changes', () => {
  test('answers only about the ids sent: changed since, and removed (missing or now non-wine)', async () => {
    const ID3 = 'c'.repeat(24);
    WineDefinition.find.mockReturnValue(chain([
      { _id: ID, updatedAt: new Date('2026-09-05'), nonWine: false },
      { _id: ID2, updatedAt: new Date('2026-08-01'), nonWine: false },
    ]));
    const res = await call('POST', '/api/bridge/v1/wines/changes', { ids: [ID, ID2, ID3], since: '2026-09-01T00:00:00Z' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(WineDefinition.find).toHaveBeenCalledWith({ _id: { $in: [ID, ID2, ID3] } });
    expect(body.changed).toEqual([{ id: ID, updatedAt: '2026-09-05T00:00:00.000Z' }]);
    expect(body.removed).toEqual([ID3]);
    expect(body.checked).toBe(3);
  });

  test('rejects an empty list, more than 5,000 ids, a bad id, or a bad date', async () => {
    expect((await call('POST', '/api/bridge/v1/wines/changes', { ids: [] })).status).toBe(400);
    expect((await call('POST', '/api/bridge/v1/wines/changes', { ids: Array(5001).fill(ID) })).status).toBe(400);
    expect((await call('POST', '/api/bridge/v1/wines/changes', { ids: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/api/bridge/v1/wines/changes', { ids: [ID], since: 'yesterday' })).status).toBe(400);
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });
});

describe('contributions', () => {
  test('a request goes through the hosted intake under the key owner and is audited with the instance', async () => {
    createWineRequest.mockResolvedValue({ wineRequest: { _id: 'r1', status: 'pending', wineName: 'Salmos 2019' } });
    const res = await call('POST', '/api/bridge/v1/requests', { wineName: 'Salmos 2019', sourceUrl: 'https://torres.es/salmos' });
    expect(res.status).toBe(201);
    expect(createWineRequest).toHaveBeenCalledWith('u1', { wineName: 'Salmos 2019', sourceUrl: 'https://torres.es/salmos', image: undefined });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bridge.request.forwarded', { type: 'wineRequest', id: 'r1' }, expect.objectContaining({ key: 'k1', instanceHost: 'cellar.example.org' }));
    createWineRequest.mockResolvedValue({ error: { status: 400, message: 'Wine name and source URL are required' } });
    expect((await call('POST', '/api/bridge/v1/requests', {})).status).toBe(400);
  });

  test('a correction is filed via the shared service with via "bridge"; service codes map to statuses', async () => {
    createFieldCorrection.mockResolvedValue({ ok: true, proposal: { _id: 'p1', status: 'pending' } });
    const res = await call('POST', '/api/bridge/v1/corrections', { wineId: ID, fields: { producer: 'Familia Torres' }, reason: 'The label reads Familia Torres.', evidenceUrl: 'https://torres.es' });
    expect(res.status).toBe(201);
    expect(createFieldCorrection).toHaveBeenCalledWith('u1', { wineId: ID, fields: { producer: 'Familia Torres' }, reason: 'The label reads Familia Torres.', evidenceUrl: 'https://torres.es' }, expect.objectContaining({ via: 'bridge' }));
    expect((await res.json()).proposal).toEqual({ id: 'p1', status: 'pending', applied: false });
    for (const [code, status] of [['invalid', 400], ['banned', 403], ['limit', 429], ['not_found', 404], ['conflict', 409]]) {
      createFieldCorrection.mockResolvedValue({ ok: false, code, message: 'm' });
      const r = await call('POST', '/api/bridge/v1/corrections', { wineId: ID });
      expect(r.status).toBe(status);
      expect((await r.json()).code).toBe(code);
    }
  });

  test('a value suggestion is filed via the shared service with via "bridge"', async () => {
    suggestValue.mockResolvedValue({ ok: true, value: { _id: 'v1', status: 'suggested' } });
    const res = await call('POST', '/api/bridge/v1/values', { wineId: ID, keyName: 'ABV', value: 14.5, reason: 'Read from the label', vintage: '2019' });
    expect(res.status).toBe(201);
    expect(suggestValue).toHaveBeenCalledWith('u1', expect.objectContaining({ wineId: ID, keyName: 'ABV', value: 14.5, vintage: '2019' }), expect.objectContaining({ via: 'bridge' }));
    expect((await res.json()).suggestion).toEqual({ id: 'v1', status: 'suggested' });
  });
});
