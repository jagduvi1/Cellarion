/**
 * POST /api/admin/ai/enrich/start — a 500 never carries the thrown error's
 * text. The known "already running" case keeps its 409; anything else answers
 * the route's fixed message and the real error stays in the server log.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/embeddingJob', () => ({ start: jest.fn(), requestStop: jest.fn(), getStatus: jest.fn() }));
jest.mock('../../services/enrichmentJob', () => ({ start: jest.fn(), requestStop: jest.fn(), getStatus: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const enrichmentJob = require('../../services/enrichmentJob');
const aiRouter = require('./ai');

function adminToken() {
  return jwt.sign({ id: 'admin1', roles: ['admin'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

function postStart(body = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ai', aiRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/admin/ai/enrich/start',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${adminToken()}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, text, body: JSON.parse(text) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('POST /api/admin/ai/enrich/start — error bodies', () => {
  test('an unexpected throw answers 500 with the fixed message, never the error text', async () => {
    enrichmentJob.start.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:27017'));

    const res = await postStart({ mode: 'full' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to start enrichment job' });
    expect(res.text).not.toContain('ECONNREFUSED');
  });

  test('the real error stays in the server log', async () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.7:27017');
    enrichmentJob.start.mockRejectedValue(err);

    await postStart();

    expect(errorSpy).toHaveBeenCalledWith('[admin/ai] POST enrich/start error:', err);
  });

  test('"A job is already running" still answers 409 with that message', async () => {
    enrichmentJob.start.mockRejectedValue(new Error('A job is already running'));

    const res = await postStart();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A job is already running' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
