/**
 * POST /api/registry-data/keys and /wine/:id say whether the contribution
 * went live at once. On a server whose admin turned review off (discussion
 * #1778) a new field is accepted and a value published as they are sent; the
 * web app reads `applied` at the top of the answer to say "live" instead of
 * "in the review queue", and to file the value right after a field it just
 * got accepted. Without it the value of a new field is never filed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/registryDataOps', () => ({ proposeKey: jest.fn(), suggestValue: jest.fn() }));
jest.mock('../services/registryBridge', () => ({ forwardValueFor: jest.fn(() => Promise.resolve(null)) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ops = require('../services/registryDataOps');
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

const post = (path, body) => fetch(`${base}/api/registry-data${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a field accepted at once says applied; one that waits says not', async () => {
  ops.proposeKey.mockResolvedValueOnce({ ok: true, applied: true, key: { _id: KEY, name: 'Vineyard area', status: 'accepted' } });
  let res = await post('/keys', { name: 'Vineyard area', type: 'decimal', rationale: 'Hectares under vine.' });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ applied: true, key: { _id: KEY, name: 'Vineyard area', status: 'accepted' } });

  ops.proposeKey.mockResolvedValueOnce({ ok: true, key: { _id: KEY, name: 'Vineyard area', status: 'proposed' } });
  res = await post('/keys', { name: 'Vineyard area', type: 'decimal', rationale: 'Hectares under vine.' });
  expect((await res.json()).applied).toBe(false);
});

test('a value published at once says applied; one that waits says not', async () => {
  const value = { _id: 'v1', key: { _id: KEY, name: 'ABV' }, value: 13.5, vintage: null, status: 'published' };
  ops.suggestValue.mockResolvedValueOnce({ ok: true, applied: true, value });
  let res = await post(`/wine/${WINE}`, { keyId: KEY, value: 13.5 });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ applied: true, value });

  ops.suggestValue.mockResolvedValueOnce({ ok: true, value: { ...value, status: 'suggested' } });
  res = await post(`/wine/${WINE}`, { keyId: KEY, value: 13.5 });
  expect((await res.json()).applied).toBe(false);
});
