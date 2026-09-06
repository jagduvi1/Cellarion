/**
 * Registry lockdown (2026-09-06, L3/L4) on GET /api/wines/:idOrSlug/public:
 * an anonymous visitor gets the prose-only profile, a signed-in member the
 * full one on the SAME endpoint; every read is counted and an anonymous
 * address past the daily distinct cap is refused; a canary page is served
 * with noindex and never says it is one.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexWine: jest.fn(), removeWine: jest.fn(), getIsAvailable: jest.fn(() => false), search: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn(), scanLabel: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn(), findOrCreateRegion: jest.fn() }));
jest.mock('../services/wineCommit', () => ({ validateNewWineFields: jest.fn(), MAX_WINE_FIELD: 200, MAX_GRAPES: 20 }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(),
  slugFilter: jest.fn((slug) => ({ $or: [{ slug: String(slug).toLowerCase() }] })),
}));
const mockGate = jest.fn();
jest.mock('../services/registryReadTracker', () => ({
  gateAnonymousRead: (...a) => mockGate(...a),
  CAP_MESSAGE: 'Daily reading limit for anonymous access reached. Sign in to keep reading, or come back tomorrow.',
}));

const WineDefinition = require('../models/WineDefinition');

const PROFILE = {
  description: 'Dark cherry, tar and roses.', body: 'full', tannin: 'firm', acidity: 'high', sweetness: 'dry',
  flavors: ['cherry', 'tar'], foodPairings: ['braised beef'], confidence: 0.8, source: 'curator',
};
const WINE = { _id: 'w1', name: 'Barolo', producer: 'Cà di Bruno', slug: 'barolo', aiProfile: PROFILE, canary: false };

let server;
let base;
beforeAll((done) => {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.use('/api/wines', require('./wines'));
  server = http.createServer(a);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const get = async (headers = {}) => {
  const res = await fetch(`${base}/api/wines/barolo/public`, { headers });
  return { status: res.status, robots: res.headers.get('x-robots-tag'), body: await res.json() };
};
const memberToken = () => jwt.sign({ id: 'a'.repeat(24), roles: ['user'], plan: 'free' }, process.env.JWT_SECRET, { expiresIn: '5m' });

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue({ allowed: true, distinct: 1 });
  WineDefinition.findOne.mockReturnValue({ populate: () => ({ select: () => Promise.resolve({ ...WINE }) }) });
});

test('an anonymous visitor gets the prose-only profile', async () => {
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(body.wine.aiProfile).toEqual({ description: PROFILE.description, style: 'full-bodied, firm tannin, high acidity, dry', source: 'curator' });
  expect(body.wine).not.toHaveProperty('canary');
});

test('a signed-in member gets the full profile on the same endpoint', async () => {
  const { status, body } = await get({ authorization: `Bearer ${memberToken()}` });
  expect(status).toBe(200);
  expect(body.wine.aiProfile).toEqual(PROFILE);
  expect(mockGate).toHaveBeenCalledTimes(1);
});

test('every read is counted, and an anonymous address past the daily cap is refused', async () => {
  mockGate.mockResolvedValue({ allowed: false, distinct: 301 });
  const { status, body } = await get();
  expect(status).toBe(429);
  expect(body.error).toMatch(/Daily reading limit/);
  expect(mockGate.mock.calls[0][1]).toBe('w1');
});

test('a canary page is served with noindex and never says it is one', async () => {
  WineDefinition.findOne.mockReturnValue({ populate: () => ({ select: () => Promise.resolve({ ...WINE, canary: true }) }) });
  const { status, robots, body } = await get();
  expect(status).toBe(200);
  expect(robots).toBe('noindex, nofollow');
  expect(body.wine).not.toHaveProperty('canary');
  expect(body.wine.name).toBe('Barolo');
});

test('a real wine page carries no robots header', async () => {
  const { robots } = await get();
  expect(robots).toBeNull();
});
