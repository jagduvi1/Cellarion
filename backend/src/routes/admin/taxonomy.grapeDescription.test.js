/**
 * Admin grape editor — a grape description is stored as plain text.
 *
 * The description is served by the public taxonomy routes and MCP
 * describe_grape; the MCP grape tools strip HTML from it, and the admin
 * create and update routes store it the same way.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  bulkIndexWines: jest.fn(),
  fullSync: jest.fn(),
  waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/Country', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn() }));
// Constructor + statics: the POST route instantiates `new Grape(...)`.
jest.mock('../../models/Grape', () => {
  const Grape = jest.fn(function (fields) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
  Grape.findById = jest.fn();
  Grape.find = jest.fn();
  Grape.exists = jest.fn();
  return Grape;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Grape = require('../../models/Grape');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const GRAPE_ID = '64b00000000000000000009e';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => jest.clearAllMocks());

const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');
const send = (method, path, body) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

describe('POST /grapes', () => {
  test('a description with tags is stored without them', async () => {
    const res = await send('POST', '/grapes', { name: 'Tinta Cão', description: '<b>Late-ripening</b> Douro <a href="x">red</a>' });
    expect(res.status).toBe(201);
    expect(Grape.mock.calls[0][0].description).toBe('Late-ripening Douro red');
  });

  test('no description stores an empty one', async () => {
    const res = await send('POST', '/grapes', { name: 'Tinta Cão' });
    expect(res.status).toBe(201);
    expect(Grape.mock.calls[0][0].description).toBe('');
  });
});

describe('PUT /grapes/:id', () => {
  const grapeDoc = () => ({
    _id: GRAPE_ID, name: 'Tinta Cão', normalizedName: 'tinta cao', synonyms: [], regionalNames: [],
    description: '', save: jest.fn().mockResolvedValue(undefined),
  });

  test('a description with tags is stored without them', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await send('PUT', `/grapes/${GRAPE_ID}`, { description: '<i>x</i>' });
    expect(res.status).toBe(200);
    expect(grape.description).toBe('x');
    expect(grape.save).toHaveBeenCalled();
  });

  test('an update without a description leaves the stored one alone', async () => {
    const grape = { ...grapeDoc(), description: 'Kept.' };
    Grape.findById.mockResolvedValue(grape);
    const res = await send('PUT', `/grapes/${GRAPE_ID}`, { origin: 'Portugal' });
    expect(res.status).toBe(200);
    expect(grape.description).toBe('Kept.');
  });
});
