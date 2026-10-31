/**
 * POST /api/registry-data/wine/:id hands a value to the Registry Bridge by
 * the CANONICAL key name the service resolved — a member's own spelling or a
 * translation of it ("Alkoholhalt") is never what the hosted registry reads.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/registryDataOps', () => ({ suggestValue: jest.fn() }));
jest.mock('../services/registryBridge', () => ({ forwardValueFor: jest.fn(() => Promise.resolve(null)) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ops = require('../services/registryDataOps');
const registryBridge = require('../services/registryBridge');
const router = require('./registryData');

const WINE = 'b'.repeat(24);
const KEY = 'c'.repeat(24);

let server;
let base;
const token = jwt.sign({ id: 'a'.repeat(24), roles: ['user'] }, process.env.JWT_SECRET);

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/registry-data', router);
  server = http.createServer(app);
  server.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => jest.clearAllMocks());

const post = (body) => fetch(`${base}/api/registry-data/wine/${WINE}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a translated key name is forwarded as the canonical one', async () => {
  ops.suggestValue.mockResolvedValue({
    ok: true,
    value: { _id: 'v1', key: { _id: KEY, name: 'ABV' }, value: 13.5, vintage: '2019', status: 'suggested' },
  });
  const res = await post({ keyName: 'Alkoholhalt', value: '13,5', vintage: '2019' });
  expect(res.status).toBe(201);
  expect(ops.suggestValue).toHaveBeenCalledWith(expect.any(String),
    expect.objectContaining({ wineId: WINE, keyName: 'Alkoholhalt' }), expect.objectContaining({ via: 'web' }));
  expect(registryBridge.forwardValueFor).toHaveBeenCalledWith(WINE,
    expect.objectContaining({ keyName: 'ABV', value: '13,5', vintage: '2019' }));
});

test('a refused suggestion is not forwarded at all', async () => {
  ops.suggestValue.mockResolvedValue({ ok: false, code: 'not_found', message: 'No such key in the accepted vocabulary' });
  const res = await post({ keyName: 'Residual sugar', value: 3 });
  expect(res.status).toBe(404);
  expect(registryBridge.forwardValueFor).not.toHaveBeenCalled();
});
