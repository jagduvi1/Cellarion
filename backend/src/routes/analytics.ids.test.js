/**
 * /api/analytics: a dashboard or view id that cannot be one.
 *
 * The four routes that take an id handed it straight to the query, and a value
 * that is not an ObjectId came back as a cast failure: 500. It is a malformed
 * request: 400, and nothing is read or written.
 *
 * Real router and auth (HS256 test tokens); the two models are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/analytics/fieldCatalogue', () => ({ composeCatalogue: jest.fn(), opsForType: jest.fn() }));
jest.mock('../services/analytics/queryEngine', () => ({ runQuery: jest.fn(), QueryError: class QueryError extends Error {} }));
jest.mock('../models/SavedDashboard', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/SavedView', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const SavedDashboard = require('../models/SavedDashboard');
const SavedView = require('../models/SavedView');
const { logAudit } = require('../services/audit');
const analyticsRouter = require('./analytics');

const USER_ID = '64b000000000000000000001';
const DOC_ID = '64b0000000000000000000d1';

function request(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: url, method,
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe.each([
  ['PUT', '/api/analytics/dashboards/', { name: 'Reds' }],
  ['DELETE', '/api/analytics/dashboards/', undefined],
  ['PUT', '/api/analytics/views/', { name: 'Reds by region' }],
  ['DELETE', '/api/analytics/views/', undefined],
])('%s %s:id', (method, base, body) => {
  test.each(['not-an-id', '12345', '64b0000000000000000000zz'])('an id of %s is a 400 and nothing is read or written', async (id) => {
    const res = await request(method, base + id, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid ID' });
    for (const Model of [SavedDashboard, SavedView]) {
      expect(Model.findOne).not.toHaveBeenCalled();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    }
    expect(logAudit).not.toHaveBeenCalled();
  });
});

test('a well-formed id of a dashboard that is not there is still a 404', async () => {
  SavedDashboard.findOne.mockResolvedValue(null);
  SavedDashboard.deleteOne.mockResolvedValue({ deletedCount: 0 });
  expect((await request('PUT', `/api/analytics/dashboards/${DOC_ID}`, { name: 'Reds' })).status).toBe(404);
  expect((await request('DELETE', `/api/analytics/dashboards/${DOC_ID}`)).status).toBe(404);
  expect(SavedDashboard.findOne).toHaveBeenCalledWith({ _id: DOC_ID, user: USER_ID });
});

test('a well-formed id of a view that is not there is still a 404', async () => {
  SavedView.findOne.mockResolvedValue(null);
  SavedView.deleteOne.mockResolvedValue({ deletedCount: 0 });
  expect((await request('PUT', `/api/analytics/views/${DOC_ID}`, { name: 'Reds' })).status).toBe(404);
  expect((await request('DELETE', `/api/analytics/views/${DOC_ID}`)).status).toBe(404);
});
