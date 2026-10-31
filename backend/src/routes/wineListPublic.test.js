/**
 * GET /api/wine-lists/public/:shareToken — the published menu as JSON.
 *
 * WHY THIS TEST EXISTS: the endpoint needs no login, so whatever it sends is
 * public. A bottle count reaches it only when the owner chose to show counts
 * (layout.showStock); a list that does not show them sends none.
 */
jest.mock('../models/WineList', () => ({ findOne: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
// Only the stock loader is replaced: the line builder needs the real entryKey.
jest.mock('../services/wineListData', () => ({ ...jest.requireActual('../services/wineListData'), loadWineMap: jest.fn() }));
jest.mock('../utils/clientIp', () => ({ rateLimitKey: () => 'test-key', getClientIp: () => '127.0.0.1' }));

const express = require('express');
const http = require('http');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const { loadWineMap } = require('../services/wineListData');
const router = require('./wineListPublic');

const lean = (value) => ({ lean: () => Promise.resolve(value), select: () => ({ lean: () => Promise.resolve(value) }) });

const BAROLO = {
  _id: 'w1', name: 'Barolo', producer: 'Conterno', type: 'red',
  country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [],
};
const list = (layout) => ({
  _id: 'l1', cellar: 'c1', name: 'Hemma', language: 'en', structureMode: 'auto', isPublished: true,
  autoGrouping: { levels: ['type'] },
  autoGroupEntries: [{ wine: 'w1', vintage: '2016', bottleSize: '750ml', listPrice: 90 }],
  layout, branding: {},
});

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/wine-lists/public', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockReturnValue(lean({ _id: 'c1', deletedAt: null }));
  loadWineMap.mockResolvedValue(new Map([['w1|2016|750ml', { wine: BAROLO, stock: 3, avgPrice: 40 }]]));
});

const wineOf = async () => {
  const res = await fetch(`${baseUrl}/api/wine-lists/public/tok`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.sections.flatMap((s) => s.wines)[0];
};

test('a list that shows counts sends each wine\'s live bottle count', async () => {
  WineList.findOne.mockReturnValue(lean(list({ showStock: true })));
  expect(await wineOf()).toMatchObject({ name: 'Barolo', bottleCount: 3 });
});

test('a list that does not show counts sends none, and never the raw stock', async () => {
  WineList.findOne.mockReturnValue(lean(list({})));
  const wine = await wineOf();
  expect(wine.name).toBe('Barolo');
  expect(wine).not.toHaveProperty('bottleCount');
  expect(wine).not.toHaveProperty('stock');
});
