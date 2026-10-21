/**
 * GET /api/wine-requests — a member's own request list populates the wine it
 * was linked to. The populate is projected like a bottle list: it never names
 * who contributed the wine or carries the curation internals.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/registryBridge', () => ({}));
jest.mock('../services/accountOps', () => ({ createWineRequest: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../models/WineRequest');
const wineRequestsRouter = require('./wineRequests');

const USER_ID = '64b000000000000000000001';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wine-requests', wineRequestsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

test('the linked wine is populated without contributor fields, curation internals or aiProfile', async () => {
  const rows = [{ _id: 'r1', wineName: 'Blanc', status: 'resolved', linkedWineDefinition: { name: 'Blanc', producer: 'Example Estate' } }];
  const query = {};
  query.populate = jest.fn(() => query);
  query.sort = jest.fn(() => Promise.resolve(rows));
  WineRequest.find.mockReturnValue(query);

  const res = await fetch(`${baseUrl}/api/wine-requests`, {
    headers: { Authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret')}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).requests[0].linkedWineDefinition).toEqual({ name: 'Blanc', producer: 'Example Estate' });

  const linked = query.populate.mock.calls.find(([path]) => path === 'linkedWineDefinition');
  const fields = String(linked[1] || '').split(/\s+/);
  expect(fields).toEqual(expect.arrayContaining([
    '-createdBy', '-contribution', '-createdVia', '-canary', '-identityProvenance',
    '-normalizedKey', '-canonicalKey', '-scanImage', '-aiProfile',
  ]));
});
