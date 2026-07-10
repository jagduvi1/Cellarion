/**
 * /api/cellar-import — upload size cap + parse concurrency gate (SECURITY_AUDIT
 * 2026-07-08 L-12).
 *
 * The importer buffers the upload in memory (multer memoryStorage) and
 * synchronously JSON.parses data.json. These tests pin the guards added around
 * that critical section:
 *   - data.json larger than 32 MB → 413 BEFORE JSON.parse is ever reached
 *   - a second concurrent import for the same user → 429 (not queued)
 *   - a third concurrent import overall (global cap 2) → 429
 *   - a valid small import still behaves exactly as before (regression)
 */
process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform — stub it (matches the repo's unit-test style).
jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  syncWine: async () => {},
}));

// Wrap the real service so parseCellarExport is a spy over the REAL parser:
// the 413 test must prove the parse was never reached, and the regression
// test must exercise the real parsing/validation logic.
jest.mock('../services/cellarImport', () => {
  const actual = jest.requireActual('../services/cellarImport');
  return {
    ...actual,
    parseCellarExport: jest.fn((...args) => actual.parseCellarExport(...args)),
    importCellar: jest.fn(),
  };
});
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const cellarImportRouter = require('./cellarImport');
const { parseCellarExport, importCellar } = require('../services/cellarImport');
const User = require('../models/User');
const Cellar = require('../models/Cellar');

function buildApp() {
  const app = express();
  app.use('/api/cellar-import', cellarImportRouter);
  return app;
}

function authHeader(userId = 'u1') {
  const token = jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}

// Minimal multipart/form-data encoder (a single "file" part).
function multipartUpload(buffer, filename = 'data.json') {
  const boundary = '----jest-boundary-4d7f1c2e';
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    'Content-Type: application/json\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postUpload(app, url, buffer, headers = {}) {
  return new Promise((resolve, reject) => {
    const { body, contentType } = multipartUpload(buffer);
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'Content-Length': body.length,
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(body);
    });
  });
}

async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const VALID_EXPORT = Buffer.from(JSON.stringify({
  schema: 'cellarion-export@1',
  cellars: [{ cellarName: 'Kitchen', description: '', racks: [], bottles: [] }],
}));

const IMPORT_RESULT = {
  sourceName: 'Kitchen',
  targetName: 'Kitchen',
  mode: 'create',
  bottlesCreated: 0,
  racksCreated: 0,
  imagesAttached: 0,
  imagesDeduped: 0,
  imagesSkipped: 0,
  winesCreated: 0,
  wineRequests: 0,
  reviewsCreated: 0,
  reviewsSkipped: 0,
  maturityCreated: 0,
  maturitySkipped: 0,
  layoutImported: false,
  errors: [],
  unplaced: [],
};

describe('/api/cellar-import size cap + concurrency gate', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ preferences: { currency: 'EUR' } }),
    });
    Cellar.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    importCellar.mockResolvedValue(IMPORT_RESULT);
  });

  test('data.json over 32 MB → 413 before JSON.parse is reached', async () => {
    // 32 MB + 1 byte of (would-be) JSON. The route must reject on byte length
    // alone — the parser spy proves the payload was never parsed.
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61); // 'a'

    const res = await postUpload(app, '/api/cellar-import/preview', oversized, authHeader());

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/32 MB/);
    expect(parseCellarExport).not.toHaveBeenCalled();
  });

  test('second concurrent import for the same user → 429 with retry hint', async () => {
    // Park the first request inside the critical section.
    let releaseImport;
    importCellar.mockImplementationOnce(
      () => new Promise((resolve) => { releaseImport = () => resolve(IMPORT_RESULT); })
    );

    const first = postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u1'));
    await waitFor(() => importCellar.mock.calls.length === 1);

    const second = await postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u1'));
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/retry/i);
    expect(second.headers['retry-after']).toBe('10');

    releaseImport();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);

    // The slot is released after completion — the same user can import again.
    const third = await postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u1'));
    expect(third.status).toBe(200);
  });

  test('global gate: two imports in flight → a third user gets 429', async () => {
    const resolvers = [];
    importCellar.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(() => resolve(IMPORT_RESULT)); })
    );

    const first = postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u1'));
    const second = postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u2'));
    await waitFor(() => importCellar.mock.calls.length === 2);

    const third = await postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u3'));
    expect(third.status).toBe(429);

    resolvers.forEach((r) => r());
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test('the gate runs BEFORE multer buffers the upload (audit BUG 8)', async () => {
    // Fill both global slots.
    const resolvers = [];
    importCellar.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(() => resolve(IMPORT_RESULT)); })
    );
    const first = postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u1'));
    const second = postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader('u2'));
    await waitFor(() => importCellar.mock.calls.length === 2);

    // A third request with a NON-multipart body (no file part). If multer ran
    // first it would 400 "No file uploaded" after reading the body; because the
    // gate is now ahead of handleUpload it 429s WITHOUT buffering anything.
    const third = await new Promise((resolve, reject) => {
      const payload = Buffer.from('not a multipart upload');
      const server = http.createServer(app);
      server.listen(0, () => {
        const req = http.request({
          port: server.address().port, path: '/api/cellar-import', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...authHeader('u3') },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end(payload);
      });
    });
    expect(third.status).toBe(429);

    resolvers.forEach((r) => r());
    await first; await second;
  });

  test('regression: a valid small import is unchanged', async () => {
    const res = await postUpload(app, '/api/cellar-import', VALID_EXPORT, authHeader());

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ targetName: 'Kitchen', mode: 'create', bottlesCreated: 0 });
    expect(parseCellarExport).toHaveBeenCalledTimes(1);
    expect(importCellar).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ cellarName: 'Kitchen' }),
      expect.objectContaining({ targetName: 'Kitchen', mode: 'create', defaultCurrency: 'EUR' })
    );
  });

  test('regression: preview of a valid export is unchanged', async () => {
    const res = await postUpload(app, '/api/cellar-import/preview', VALID_EXPORT, authHeader());

    expect(res.status).toBe(200);
    expect(res.body.cellars).toEqual([
      expect.objectContaining({
        sourceName: 'Kitchen',
        defaultTargetName: 'Kitchen',
        willOverwrite: false,
        bottleCount: 0,
      }),
    ]);
    expect(res.body.hasImageFiles).toBe(false);
  });

  test('invalid JSON under the cap still fails with the parser 400 (cap does not mask it)', async () => {
    const res = await postUpload(app, '/api/cellar-import/preview', Buffer.from('{nope'), authHeader());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid JSON/i);
    expect(parseCellarExport).toHaveBeenCalledTimes(1);
  });
});
