/**
 * SuperAdmin → AI: the prompt save routes (PATCH /api/superadmin/ai/<*>-prompt)
 * and the caps GET /api/superadmin/ai sends to the page.
 *
 * Each prompt is refused above its own cap (PROMPT_MAX_LENGTHS). The shipped
 * defaults must save as they are, and the page reads the caps from the GET so
 * its character counters show the same limit the server applies.
 *
 * Auth is stubbed to a signed-in super admin (the real gate has its own
 * suite); the router's heavy services and the models GET /ai counts are
 * stubbed.
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'admin-1', roles: ['admin'] }; next(); },
}));
jest.mock('../middleware/superAdmin', () => ({ requireSuperAdmin: (req, res, next) => next() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../services/embeddingJob', () => ({ getStatus: () => ({ status: 'idle' }) }));
jest.mock('../services/enrichmentJob', () => ({ getStatus: () => ({ status: 'idle' }) }));
jest.mock('../services/vectorStore', () => ({ stats: async () => ({ rows: 0, dims: [], bytes: 0, memory: null }) }));
jest.mock('../services/aiChat', () => ({ getEventLog: () => [] }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));

const express = require('express');
const http = require('http');
const aiConfig = require('../config/aiConfig');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const { updateSiteConfig } = require('../utils/siteConfig');
const { PROMPT_MAX_LENGTHS } = require('../config/constants');
const superadminRouter = require('./superadmin');

function call(method, path, body) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/superadmin', superadminRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// Every prompt route and the aiConfig key it saves.
const PROMPT_ROUTES = [
  ['/api/superadmin/ai/system-prompt', 'chatSystemPrompt'],
  ['/api/superadmin/ai/label-scan-prompt', 'labelScanPrompt'],
  ['/api/superadmin/ai/label-scan-back-prompt', 'labelScanBackPrompt'],
  ['/api/superadmin/ai/receipt-scan-prompt', 'receiptScanPrompt'],
  ['/api/superadmin/ai/import-lookup-prompt', 'importLookupPrompt'],
  ['/api/superadmin/ai/maturity-suggest-prompt', 'maturitySuggestPrompt'],
  ['/api/superadmin/ai/maturity-suggest-prompt-nv', 'maturitySuggestPromptNv'],
  ['/api/superadmin/ai/price-suggest-prompt', 'priceSuggestPrompt'],
  ['/api/superadmin/ai/enrichment-prompt', 'enrichmentPrompt'],
];

beforeEach(() => {
  jest.clearAllMocks();
  updateSiteConfig.mockResolvedValue(undefined);
  aiConfig.set({});
});

describe('PATCH /api/superadmin/ai/<*>-prompt', () => {
  test.each(PROMPT_ROUTES)('%s accepts the shipped default and stores no copy of it', async (path, key) => {
    const res = await call('PATCH', path, { prompt: aiConfig.defaults[key] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ [key]: aiConfig.defaults[key].trim() });
    // The running config holds the default; the document does not carry a
    // copy, so a later default reaches this instance on its next boot.
    expect(aiConfig.getRaw()[key]).toBe(aiConfig.defaults[key].trim());
    expect(updateSiteConfig).toHaveBeenCalledTimes(1);
    expect(updateSiteConfig.mock.calls[0][0]).toBe('aiConfig');
    expect(updateSiteConfig.mock.calls[0][1]).not.toHaveProperty(key);
    expect(updateSiteConfig.mock.calls[0][2]).toBe('admin-1');
  });

  test('a reworded prompt is stored; the untouched defaults beside it are not', async () => {
    const res = await call('PATCH', '/api/superadmin/ai/label-scan-prompt', { prompt: 'Read the label.' });
    expect(res.status).toBe(200);
    const stored = updateSiteConfig.mock.calls[0][1];
    expect(stored.labelScanPrompt).toBe('Read the label.');
    expect(stored).not.toHaveProperty('importLookupPrompt');
    expect(aiConfig.getRaw().importLookupPrompt).toBe(aiConfig.defaults.importLookupPrompt);
  });

  test.each(PROMPT_ROUTES)('%s refuses a prompt one character over its cap, without saving', async (path, key) => {
    const cap = PROMPT_MAX_LENGTHS[key];
    const res = await call('PATCH', path, { prompt: 'x'.repeat(cap + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`prompt must be ${cap} characters or fewer`);
    expect(updateSiteConfig).not.toHaveBeenCalled();
  });

  test('the enrichment prompt saves at exactly its cap', async () => {
    const prompt = 'x'.repeat(PROMPT_MAX_LENGTHS.enrichmentPrompt);
    const res = await call('PATCH', '/api/superadmin/ai/enrichment-prompt', { prompt });
    expect(res.status).toBe(200);
    expect(aiConfig.getRaw().enrichmentPrompt).toBe(prompt);
  });
});

describe('GET /api/superadmin/ai', () => {
  test('carries the cap of every prompt for the page counters', async () => {
    jest.spyOn(WineDefinition, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(WineEmbedding, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(WineEmbedding, 'aggregate').mockResolvedValue([]);
    jest.spyOn(WineEmbedding, 'findOne').mockReturnValue({
      sort: () => ({ select: () => ({ lean: async () => null }) }),
    });

    const res = await call('GET', '/api/superadmin/ai');
    expect(res.status).toBe(200);
    expect(res.body.promptLimits).toEqual(PROMPT_MAX_LENGTHS);
    for (const [, key] of PROMPT_ROUTES) expect(res.body.promptLimits[key]).toEqual(expect.any(Number));
  });
});
