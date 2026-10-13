/**
 * GET /api/wines?ownHidden=1 — a member's own quarantined drinks come first in
 * the pickers that put a bottle on the pick (2026-10-13), and only there.
 */
process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform — stub it (matches the repo's unit-test style).
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  search: jest.fn(async () => ({ ids: [], estimatedTotalHits: 0 })),
}));
jest.mock('../services/ownHiddenWines', () => ({ findOwnHiddenWineIds: jest.fn() }));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(),
  detectImageFormat: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn().mockReturnValue(false),
  isRefundableScanError: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');
const { findOwnHiddenWineIds } = require('../services/ownHiddenWines');
const winesRouter = require('./wines');

const USER_ID = '64b000000000000000000001';
const BEER = '64b0000000000000000000b1';
const WINE = '64b0000000000000000000c1';

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};
const beer = () => ({ _id: BEER, name: 'Pale Lager', producer: 'Example Brewery', nonWine: true, grapes: [] });
const wine = () => ({ _id: WINE, name: 'Blanc', producer: 'Example Estate', grapes: [] });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
  return app;
}

function get(url) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'GET',
          headers: {
            authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}


beforeEach(() => {
  jest.clearAllMocks();
  searchService.getIsAvailable.mockReturnValue(false);
  findOwnHiddenWineIds.mockResolvedValue([BEER]);
  // First find = the own hidden rows, the next = the registry list.
  WineDefinition.find.mockReturnValueOnce(chain([beer()])).mockReturnValue(chain([wine()]));
  WineDefinition.countDocuments.mockResolvedValue(1);
});

test("the Mongo path puts the caller's own hidden drink first, flagged nonWine", async () => {
  const { status, body } = await get('/api/wines?search=lager&ownHidden=1');
  expect(status).toBe(200);
  expect(findOwnHiddenWineIds).toHaveBeenCalledWith(USER_ID, 'lager');
  expect(WineDefinition.find.mock.calls[0][0]).toEqual({ _id: { $in: [BEER] }, nonWine: true });
  expect(body.wines.map((w) => w._id)).toEqual([BEER, WINE]);
  expect(body.wines[0].nonWine).toBe(true);
  expect(body.count).toBe(2);
  expect(body.total).toBe(2);
});

test('the Meilisearch path does the same', async () => {
  searchService.getIsAvailable.mockReturnValue(true);
  searchService.search.mockResolvedValue({ ids: [WINE], estimatedTotalHits: 7 });
  const { body } = await get('/api/wines?search=lager&ownHidden=1');
  expect(body.wines.map((w) => w._id)).toEqual([BEER, WINE]);
  expect(body.total).toBe(8);
});

test('without ownHidden=1 (a forum wine tag, a wine-request link) nothing hidden is looked up', async () => {
  WineDefinition.find.mockReset();
  WineDefinition.find.mockReturnValue(chain([wine()]));
  const { body } = await get('/api/wines?search=lager');
  expect(findOwnHiddenWineIds).not.toHaveBeenCalled();
  expect(body.wines.map((w) => w._id)).toEqual([WINE]);
});

test('later pages carry no own rows', async () => {
  WineDefinition.find.mockReset();
  WineDefinition.find.mockReturnValue(chain([wine()]));
  await get('/api/wines?search=lager&ownHidden=1&offset=10');
  expect(findOwnHiddenWineIds).not.toHaveBeenCalled();
});

test('a failed lookup never costs the search', async () => {
  findOwnHiddenWineIds.mockRejectedValue(new Error('db down'));
  WineDefinition.find.mockReset();
  WineDefinition.find.mockReturnValue(chain([wine()]));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { status, body } = await get('/api/wines?search=lager&ownHidden=1');
  expect(status).toBe(200);
  expect(body.wines.map((w) => w._id)).toEqual([WINE]);
  warn.mockRestore();
});
