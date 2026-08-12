/**
 * POST /api/wines/scan-label — fail-closed image sanitization (SECURITY_AUDIT L-9).
 *
 * The route must run the decoded base64 buffer through sanitizeImageBuffer()
 * BEFORE anything (rembg, Claude) touches the bytes: a small compressed payload
 * can otherwise decode into a 100M+ pixel "decompression bomb" on the
 * single-worker rembg service. Invalid/oversized input → 400; valid input is
 * re-encoded (EXIF stripped) and its media type re-detected from the actual
 * bytes, not the client-declared mediaType.
 */
process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform — stub it (matches the repo's unit-test style).
jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
}));
// The Anthropic-backed extractor: never reached in the 400 test; returns a
// no-match extraction in the happy-path test.
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
// Rate limiting is exercised elsewhere; keep this suite about sanitization.
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
// The daily AI budget (services/aiBudget) hits MongoDB — mocked out here; the
// budget behaviour itself is covered by wines.aiBudget.test.js.
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn().mockReturnValue(false),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const winesRouter = require('./wines');
const { scanLabelFull } = require('../services/labelScan');

sharp.cache(false);

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/wines', winesRouter);
  return app;
}

function postJson(app, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

function authHeader() {
  const token = jwt.sign({ id: 'u1', roles: ['user'] }, 'test-secret', {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}

describe('POST /api/wines/scan-label sanitization', () => {
  const realFetch = global.fetch;
  let app;

  beforeEach(() => {
    app = buildApp();
    // rembg unreachable in tests — the route must fall back to the sanitized
    // original instead of failing.
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  test('rejects a non-image payload with 400 before touching rembg or Claude', async () => {
    const res = await postJson(
      app,
      '/api/wines/scan-label',
      { image: Buffer.from('definitely not an image').toString('base64'), mediaType: 'image/jpeg' },
      authHeader()
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid JPEG, PNG, or WebP/);
    expect(global.fetch).not.toHaveBeenCalled();      // never forwarded to rembg
    expect(scanLabelFull).not.toHaveBeenCalled();     // never forwarded to Claude
  });

  test('still requires an image', async () => {
    const res = await postJson(app, '/api/wines/scan-label', {}, authHeader());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Image is required');
  });

  test('valid image passes through sanitized, with the type detected from the bytes', async () => {
    // A real PNG declared as image/jpeg — the declared type must be ignored.
    const png = await sharp({
      create: { width: 6, height: 4, channels: 3, background: { r: 120, g: 0, b: 40 } },
    }).png().toBuffer();
    scanLabelFull.mockResolvedValue({ name: null, producer: null });

    const res = await postJson(
      app,
      '/api/wines/scan-label',
      { image: png.toString('base64'), mediaType: 'image/jpeg' },
      authHeader()
    );

    expect(res.status).toBe(200);
    expect(res.body.match).toBeNull();
    expect(res.body.labelImage).toMatch(/^data:image\/png;base64,/);
    // Claude received the sanitized buffer with the DETECTED media type.
    expect(scanLabelFull).toHaveBeenCalledWith(expect.any(String), 'image/png', { allowPartial: true });
    const sentBuffer = Buffer.from(scanLabelFull.mock.calls[0][0], 'base64');
    const meta = await sharp(sentBuffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(6);
  });
});
