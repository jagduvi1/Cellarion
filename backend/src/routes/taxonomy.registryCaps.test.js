/**
 * Registry lockdown (2026-09-06, L2/L4) — the four public taxonomy listings
 * were the cheapest full copy of the registry: 100 wines a page, offset up to
 * a million, sixty requests a window. Now 48 a page, 2,000 deep, canaries only
 * in the deep pages, and `total` never counts a canary.
 */
const mockWineFind = jest.fn();
const mockWineCount = jest.fn();
jest.mock('../models/WineDefinition', () => ({
  aggregate: jest.fn(), countDocuments: (...a) => mockWineCount(...a), find: (...a) => mockWineFind(...a),
}));
jest.mock('../models/Grape', () => ({ find: jest.fn(), findOne: jest.fn() }));
const mockCountryFindOne = jest.fn();
jest.mock('../models/Country', () => ({ find: jest.fn(), findOne: (...a) => mockCountryFindOne(...a) }));
jest.mock('../models/Region', () => ({ find: jest.fn(() => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) })), findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const router = require('./taxonomy');

const chain = (rows) => {
  const c = {};
  for (const m of ['select', 'populate', 'sort', 'skip', 'limit']) c[m] = jest.fn(() => c);
  c.lean = async () => rows;
  return c;
};

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const COUNTRY = { _id: '64b000000000000000000cc3', name: 'Italy', slug: 'italy' };
let lastChain;
beforeEach(() => {
  jest.clearAllMocks();
  mockCountryFindOne.mockReturnValue({ select: () => ({ lean: async () => COUNTRY }) });
  mockWineFind.mockImplementation(() => { lastChain = chain([]); return lastChain; });
  mockWineCount.mockResolvedValue(500);
});

const get = (qs) => fetch(`${baseUrl}/api/taxonomy/countries/italy${qs}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test('a page is at most 48 wines, whatever the client asks for', async () => {
  const { status, body } = await get('?limit=100');
  expect(status).toBe(200);
  expect(body.limit).toBe(48);
  expect(lastChain.limit).toHaveBeenCalledWith(48);
});

test('the offset is capped at 2,000 — nobody legitimate reads page 400', async () => {
  const { body } = await get('?offset=999999');
  expect(body.offset).toBe(2000);
  expect(lastChain.skip).toHaveBeenCalledWith(2000);
});

test('the first pages never contain a canary', async () => {
  await get('?offset=0');
  expect(mockWineFind.mock.calls[0][0]).toMatchObject({ country: COUNTRY._id, canary: { $ne: true } });
});

test('the deep pages do — that is where a walker meets one', async () => {
  await get('?offset=960');
  expect(mockWineFind.mock.calls[0][0]).not.toHaveProperty('canary');
  expect(mockWineFind.mock.calls[0][0]).toMatchObject({ country: COUNTRY._id, nonWine: { $ne: true } });
});

test('total never counts canaries, so the visible page count stays honest', async () => {
  await get('?offset=960');
  expect(mockWineCount.mock.calls[0][0]).toMatchObject({ canary: { $ne: true } });
});
