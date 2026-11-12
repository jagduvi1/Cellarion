/**
 * The Registry Bridge and the label sweetness term (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * Self-hosted installs update on their own schedule. A peer on protocol v1 —
 * no header — must receive byte for byte what it always did: the name AS THE
 * LABEL READS IT (name + term) and no `labelSweetness` key, so its own keys and
 * names never move. A v2 peer gets the bare name and the term as its own field,
 * by word and scale (never an id). /me says which protocol answered and what
 * the server accepts. Same mocks as bridgeV1.test.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/RegistryDataValue', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ find: jest.fn(), updateOne: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}) }));
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
jest.mock('../models/BridgeKey', () => ({
  findOneAndUpdate: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'k1' }) }) })),
}));
jest.mock('../middleware/bridgeKeyAuth', () => ({
  requireBridgeKey: jest.fn((req, res, next) => {
    if (req.headers['x-test-key'] !== 'good') return res.status(401).json({ code: 'no_key' });
    req.user = { id: 'u1', roles: ['user'] };
    req.bridge = { key: { id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org' }, keyDoc: { _id: 'k1', user: 'u1', createdAt: new Date(), termsVersion: '2026-09' } };
    next();
  }),
}));
jest.mock('../services/bridgeQuota', () => ({
  quota: jest.fn(() => (req, res, next) => next()),
  usageFor: jest.fn().mockResolvedValue({ day: '2026-09-08', used: {}, caps: {} }),
  QUOTAS: { searches: 600, fetches: 300, changeChecks: 1, contributions: 50 },
  capsNow: () => ({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50 }),
}));

const express = require('express');
const http = require('http');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const RegistryDataValue = require('../models/RegistryDataValue');
const router = require('./bridgeV1');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/bridge/v1', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  WineVintageProfile.aggregate.mockResolvedValue([]);
  RegistryDataValue.aggregate.mockResolvedValue([]);
});

const call = (path, headers = {}) => fetch(`${baseUrl}${path}`, { headers: { 'x-test-key': 'good', ...headers } });
const V2 = { 'x-cellarion-bridge-protocol': '2' };
const chain = (result) => {
  const c = {};
  for (const m of ['select', 'populate', 'sort', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};
const ID = 'a'.repeat(24);
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };
const wine = (over = {}) => ({
  _id: ID, name: 'Riesling Kabinett', producer: 'Weingut Keller', slug: 'weingut-keller-riesling-kabinett-trocken', type: 'white', appellation: 'Rheinhessen',
  region: { name: 'Rheinhessen' }, country: { name: 'Germany' }, grapes: [{ name: 'Riesling' }],
  image: null, imageCredit: null, labelSweetness: TROCKEN, ...over,
});

test('GET /me: a v1 peer gets exactly the reply it always got; a v2 peer also learns what the server accepts', async () => {
  const v1 = await (await call('/api/bridge/v1/me')).json();
  expect(v1).toMatchObject({ protocol: 'v1' });
  expect(v1).not.toHaveProperty('accepts');
  expect(Object.keys(v1).sort()).toEqual(['burstPerMinute', 'key', 'protocol', 'quotas', 'terms', 'usage']);
  expect(await (await call('/api/bridge/v1/me', V2)).json()).toMatchObject({ protocol: 'v2', accepts: ['v1', 'v2'] });
  expect(await (await call('/api/bridge/v1/me', { 'x-cellarion-bridge-protocol': '7' })).json()).toMatchObject({ protocol: 'v2' });
  expect(await (await call('/api/bridge/v1/me', { 'x-cellarion-bridge-protocol': 'x' })).json()).toMatchObject({ protocol: 'v1' });
});

test('search on v1: a wine with a term is sent under the name as the label reads it, with no labelSweetness key — the wire a v1 peer always had', async () => {
  WineDefinition.find.mockReturnValue(chain([wine()]));
  const body = await (await call('/api/bridge/v1/search?q=kabinett')).json();
  expect(body.wines[0]).toEqual({
    id: ID, slug: 'weingut-keller-riesling-kabinett-trocken', producer: 'Weingut Keller', name: 'Riesling Kabinett trocken', type: 'white', colour: null,
    appellation: 'Rheinhessen', classification: null, classifications: [], region: 'Rheinhessen', country: 'Germany', grapes: ['Riesling'], image: null, imageCredit: null,
  });
  expect(body.wines[0]).not.toHaveProperty('labelSweetness');
});

test('search on v2: the bare name and the term as its own field by word and scale; null when the wine has none', async () => {
  WineDefinition.find.mockReturnValue(chain([wine(), wine({ _id: 'b'.repeat(24), name: 'Salmos', labelSweetness: null })]));
  const body = await (await call('/api/bridge/v1/search?q=kabinett', V2)).json();
  expect(body.wines[0]).toMatchObject({ name: 'Riesling Kabinett', labelSweetness: { name: 'trocken', band: 'dry', scale: 'still', regulated: true } });
  expect(body.wines[0].labelSweetness).not.toHaveProperty('_id');
  expect(body.wines[1]).toMatchObject({ name: 'Salmos', labelSweetness: null });
});

test('a v1 wine whose name already carries the word is not doubled', async () => {
  WineDefinition.find.mockReturnValue(chain([wine({ name: 'Riesling Kabinett trocken' })]));
  const body = await (await call('/api/bridge/v1/search?q=kabinett')).json();
  expect(body.wines[0].name).toBe('Riesling Kabinett trocken');
});

test('every identity read populates the term', async () => {
  WineDefinition.find.mockReturnValue(chain([wine()]));
  await call('/api/bridge/v1/search?q=kabinett');
  const populate = WineDefinition.find.mock.results[0].value.populate;
  expect(populate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ path: 'labelSweetness' })]));
});

// The sweetness style: the term a wine is KNOWN by when its label states
// none, named by the producer or the trade. Descriptive, so it travels beside
// the identity on v2 only — by word and scale with its source and link — and
// a v1 peer never sees it, in a field or in the name.
const STYLE = { term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: 'https://merchant.example/riesling-kabinett' };

test('the sweetness style on v2: its own field, by word and scale with source and link; null when none; never in the name', async () => {
  WineDefinition.find.mockReturnValue(chain([wine({ labelSweetness: null, sweetnessStyle: STYLE }), wine({ _id: 'b'.repeat(24), name: 'Salmos', labelSweetness: null, sweetnessStyle: null })]));
  const body = await (await call('/api/bridge/v1/search?q=kabinett', V2)).json();
  expect(body.wines[0]).toMatchObject({
    name: 'Riesling Kabinett',
    sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: STYLE.url },
  });
  expect(body.wines[1].sweetnessStyle).toBeNull();
});

test('a v1 peer never sees the sweetness style: no key, and the name is the label\'s', async () => {
  WineDefinition.find.mockReturnValue(chain([wine({ labelSweetness: null, sweetnessStyle: STYLE })]));
  const body = await (await call('/api/bridge/v1/search?q=kabinett')).json();
  expect(body.wines[0]).not.toHaveProperty('sweetnessStyle');
  expect(body.wines[0].name).toBe('Riesling Kabinett');
});

test('every identity read selects the style and populates its term', async () => {
  WineDefinition.find.mockReturnValue(chain([wine()]));
  await call('/api/bridge/v1/search?q=kabinett', V2);
  const c = WineDefinition.find.mock.results[0].value;
  const selected = c.select.mock.calls[0][0];
  expect(typeof selected === 'string' ? selected.split(' ') : Object.keys(selected)).toContain('sweetnessStyle');
  expect(c.populate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ path: 'sweetnessStyle.term' })]));
});
