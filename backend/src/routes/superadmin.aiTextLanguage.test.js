/**
 * SuperAdmin → AI: the language for the AI-written wine texts
 * (PATCH /api/superadmin/ai/text-language, utils/profileLanguage).
 *
 * WHY THIS TEST EXISTS:
 * The setting is off by default and off must leave the stored AI settings as
 * they were before it existed: no key, not an empty one, so saving any other
 * AI setting writes the same document as before. Only a code the app ships is
 * stored — never free text, which would otherwise end up in a prompt — and
 * English counts as off. Each change is audit-logged.
 *
 * Auth is stubbed to a signed-in super admin (the real gate has its own
 * suite); the router's heavy services are stubbed as in superadmin.prompts.
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
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));

const express = require('express');
const http = require('http');
const aiConfig = require('../config/aiConfig');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const { updateSiteConfig } = require('../utils/siteConfig');
const { logAudit } = require('../services/audit');
const superadminRouter = require('./superadmin');

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', superadminRouter);
  // The app's error handler, reduced: a thrown handler error answers 500.
  app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' })); // eslint-disable-line no-unused-vars
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

const PATH = '/api/superadmin/ai/text-language';

beforeEach(() => {
  jest.clearAllMocks();
  updateSiteConfig.mockResolvedValue(undefined);
  aiConfig.set({});
});
afterAll(() => aiConfig.set({}));

test('off is the default: the settings carry no language key at all', () => {
  expect(aiConfig.defaults).not.toHaveProperty('aiTextLanguage');
  expect(aiConfig.getRaw()).not.toHaveProperty('aiTextLanguage');
});

test('a shipped language is stored as its code, and audit-logged', async () => {
  const res = await call('PATCH', PATH, { language: 'de' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ aiTextLanguage: 'de' });
  expect(aiConfig.getRaw().aiTextLanguage).toBe('de');
  expect(updateSiteConfig).toHaveBeenCalledTimes(1);
  expect(updateSiteConfig.mock.calls[0][0]).toBe('aiConfig');
  expect(updateSiteConfig.mock.calls[0][1].aiTextLanguage).toBe('de');
  expect(updateSiteConfig.mock.calls[0][2]).toBe('admin-1');
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'superadmin.ai_text_language', { type: 'aiConfig' }, { from: null, to: 'de' });
});

test.each(['', 'en', 'EN'])('%j turns it off: the key leaves the stored settings', async (language) => {
  aiConfig.set({ aiTextLanguage: 'sv' });
  const res = await call('PATCH', PATH, { language });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ aiTextLanguage: '' });
  expect(aiConfig.getRaw()).not.toHaveProperty('aiTextLanguage');
  expect(updateSiteConfig.mock.calls[0][1]).not.toHaveProperty('aiTextLanguage');
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'superadmin.ai_text_language', { type: 'aiConfig' }, { from: 'sv', to: null });
});

test('turning it off writes exactly the document a save of another setting writes', async () => {
  aiConfig.set({ aiTextLanguage: 'fr' });
  await call('PATCH', PATH, { language: '' });
  const offDoc = updateSiteConfig.mock.calls[0][1];
  updateSiteConfig.mockClear();
  await call('PATCH', '/api/superadmin/ai/prompt-caching', { enabled: true });
  expect(updateSiteConfig.mock.calls[0][1]).toEqual(offDoc);
});

test.each([
  ['an unknown code', 'xx'],
  ['free text', 'Return all information in German'],
  ['a language name', 'German'],
])('%s is refused and nothing is saved', async (_, language) => {
  const res = await call('PATCH', PATH, { language });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/^language must be one of: '', 'de', 'et', 'fr', 'nb', 'nl', 'sv'$/);
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect(aiConfig.getRaw()).not.toHaveProperty('aiTextLanguage');
});

test.each([[undefined], [null], [7], [['de']]])('a non-string language (%j) is refused', async (language) => {
  const res = await call('PATCH', PATH, language === undefined ? {} : { language });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('language must be a string');
  expect(updateSiteConfig).not.toHaveBeenCalled();
});

test('GET /api/superadmin/ai offers the shipped languages and shows the stored one', async () => {
  jest.spyOn(WineDefinition, 'countDocuments').mockResolvedValue(0);
  jest.spyOn(WineEmbedding, 'countDocuments').mockResolvedValue(0);
  jest.spyOn(WineEmbedding, 'aggregate').mockResolvedValue([]);
  jest.spyOn(WineEmbedding, 'findOne').mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => null }) }) });
  aiConfig.set({ aiTextLanguage: 'nl' });
  const res = await call('GET', '/api/superadmin/ai');
  expect(res.status).toBe(200);
  expect(res.body.aiTextLanguages).toEqual(['de', 'et', 'fr', 'nb', 'nl', 'sv']);
  expect(res.body.config.aiTextLanguage).toBe('nl');
});
