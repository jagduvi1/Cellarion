/**
 * The anonymous wine endpoint is rate-limited against enumeration.
 *
 * GET /api/wines/:idOrSlug/public needs no account — that is deliberate, it is
 * how a wine page is shared and indexed. But it sat under the general /api/
 * limiter (2500 per 15 min), which meant one address could download the whole
 * registry in roughly forty minutes. Public and bulk-downloadable are not the
 * same thing, and until this they were.
 *
 * The cap is measured, not guessed: across 24 hours the endpoint served five
 * requests, from one address, all real browsers, with no search crawler
 * touching it — so 120 per 15 minutes is ~20x the site's entire daily use of
 * it, per address, and invisible to anyone actually reading wine pages.
 */
const express = require('express');
const http = require('http');

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
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));

const rateLimitsConfig = require('../config/rateLimits');
const { logAudit } = require('../services/audit');
const WineDefinition = require('../models/WineDefinition');

const WINE = { _id: 'w1', name: 'Barolo', producer: 'Cà di Bruno', slug: 'barolo' };

function app() {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.use('/api/wines', require('./wines'));
  return a;
}

/** Fire n sequential requests from one address; return the status list. */
async function hit(a, n, ip = '203.0.113.7') {
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const codes = [];
  for (let i = 0; i < n; i++) {
    codes.push(await new Promise((resolve, reject) => {
      http.get({ port, path: '/api/wines/barolo/public', headers: { 'x-forwarded-for': ip } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    }));
  }
  server.close();
  return codes;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  WineDefinition.findOne.mockReturnValue({ select: () => Promise.resolve(WINE) });
});

describe('anonymous registry reads are capped against enumeration', () => {
  test('the configured cap is a real number with a window', () => {
    const cfg = rateLimitsConfig.get().publicWineRead;
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.windowMs).toBeGreaterThan(0);
  });

  test('the default clears real browsing by a wide margin', () => {
    // Measured: the endpoint served 5 requests site-wide in 24h. The cap must
    // sit far above any human session, or it becomes a bug report instead of
    // a defence.
    const { max, windowMs } = rateLimitsConfig.get().publicWineRead;
    const perMinute = max / (windowMs / 60000);
    expect(perMinute).toBeGreaterThan(4); // a wine page every 15s, sustained
    expect(max).toBeGreaterThanOrEqual(60);
  });

  test('the default still makes a single-address full scrape impractical', () => {
    // ~6,800 wines. At the cap, one address needs many hours rather than one
    // lunch break — which is the whole point.
    const { max, windowMs } = rateLimitsConfig.get().publicWineRead;
    const hoursForFullRegistry = (6800 / max) * (windowMs / 3600000);
    expect(hoursForFullRegistry).toBeGreaterThan(6);
  });

  test('requests past the cap are refused with 429', async () => {
    jest.spyOn(rateLimitsConfig, 'get').mockReturnValue({
      ...rateLimitsConfig.get(), publicWineRead: { max: 3, windowMs: 60000 },
    });
    const codes = await hit(app(), 5);
    expect(codes.slice(0, 3).every((c) => c === 200)).toBe(true);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  test('a refusal is audited — ordinary use cannot reach the cap, so a breach is worth seeing', async () => {
    jest.spyOn(rateLimitsConfig, 'get').mockReturnValue({
      ...rateLimitsConfig.get(), publicWineRead: { max: 1, windowMs: 60000 },
    });
    await hit(app(), 2);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'system.rate_limit_exceeded', {},
      expect.objectContaining({ limiter: 'publicWineRead' })
    );
  });

  test('the cap is per address — one scraper does not lock out everyone else', async () => {
    jest.spyOn(rateLimitsConfig, 'get').mockReturnValue({
      ...rateLimitsConfig.get(), publicWineRead: { max: 2, windowMs: 60000 },
    });
    const a = app();
    await hit(a, 3, '203.0.113.1');            // exhausts that address
    const other = await hit(a, 1, '198.51.100.9');
    expect(other).toEqual([200]);
  });
});
