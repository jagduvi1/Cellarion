/**
 * POST /api/admin/import/wines — an import that fails outright answers
 * { error: 'Import failed' }. In production the thrown error's text stays in
 * the server log only (the same rule as app.js's central handler); outside
 * production it rides along as `details` for the admin running the import.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({
  findById: jest.fn(), findOne: jest.fn(), findFreeSlug: jest.fn(), bulkWrite: jest.fn(),
}));
jest.mock('../../models/Country', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Region', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateRegion: jest.fn(), regionForAppellation: jest.fn() }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (n) => n) }));
jest.mock('../../services/producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (p) => p) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const importRouter = require('./import');

function adminToken() {
  return jwt.sign({ id: 'admin1', roles: ['admin'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

function postCsv(csv) {
  const app = express();
  app.use('/api/admin/import', importRouter);
  const boundary = 'importErrorBodyTestBoundary';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wines.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`
  );
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port,
        path: '/api/admin/import/wines',
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken()}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(body);
    });
  });
}

// A quoted cell that never closes: the CSV parser throws mid-stream, which no
// per-row handler absorbs, so the whole import fails.
const BROKEN_CSV = [
  'Producer,Wine,Country,Region,Appellation,WineType',
  '"Domaine Un,Cuvee A,France,Bourgogne,,Red',
].join('\r\n');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  errorSpy.mockRestore();
});

describe('POST /api/admin/import/wines — a failed import', () => {
  test('in production answers only { error: "Import failed" }', async () => {
    process.env.NODE_ENV = 'production';

    const res = await postCsv(BROKEN_CSV);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Import failed' });
    expect(WineDefinition.bulkWrite).not.toHaveBeenCalled();
  });

  test('in production the real error stays in the server log', async () => {
    process.env.NODE_ENV = 'production';

    await postCsv(BROKEN_CSV);

    expect(errorSpy).toHaveBeenCalledWith('Wine import error:', expect.any(Error));
    const [, logged] = errorSpy.mock.calls.find(([label]) => label === 'Wine import error:');
    expect(logged.message).toBeTruthy();
  });

  test('outside production the error text is still sent as details', async () => {
    process.env.NODE_ENV = 'development';

    const res = await postCsv(BROKEN_CSV);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Import failed');
    expect(typeof res.body.details).toBe('string');
    expect(res.body.details.length).toBeGreaterThan(0);
  });
});
