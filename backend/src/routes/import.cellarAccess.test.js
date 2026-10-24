/**
 * Cellar access on the import routes that take a cellarId:
 * POST /validate, POST /confirm, POST /sessions and GET /sessions.
 *
 * They answer the way middleware/cellarAccess does everywhere else:
 *   - a caller with no role in the cellar gets 404 'Cellar not found', the
 *     same answer as a cellar that does not exist, so a cellar id cannot be
 *     probed for existence;
 *   - a viewer may see the cellar but not import into it: 403 with one
 *     message on the three writing routes, and the draft list on GET;
 *   - a soft-deleted cellar is missing, whoever asks.
 *
 * Real router + real requireAuth (HS256 test tokens); models are mocked, and
 * every refused request must stop before any registry, session or bottle work.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => jest.fn());
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/ImportSession', () => {
  const instances = [];
  function ImportSession(data) {
    Object.assign(this, data);
    this._id = '64b0000000000000000000ee';
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  ImportSession.__instances = instances;
  ImportSession.deleteMany = jest.fn().mockResolvedValue({});
  ImportSession.find = jest.fn(() => {
    const chain = { select: () => chain, sort: () => chain, lean: async () => [] };
    return chain;
  });
  return ImportSession;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const ImportSession = require('../models/ImportSession');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return app;
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(buildApp());
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const headers = { authorization: `Bearer ${token}` };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { port: server.address().port, path: url, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const ITEMS = [{ wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' }];
const ROUTES = {
  validate: () => request('POST', '/api/bottles/import/validate', { cellarId: CELLAR_ID, items: ITEMS }),
  confirm: () => request('POST', '/api/bottles/import/confirm', { cellarId: CELLAR_ID, items: ITEMS }),
  createSession: () => request('POST', '/api/bottles/import/sessions', { cellarId: CELLAR_ID, results: [{ index: 0, item: ITEMS[0] }] }),
  listSessions: () => request('GET', `/api/bottles/import/sessions?cellarId=${CELLAR_ID}`),
};
const WRITING_ROUTES = ['validate', 'confirm', 'createSession'];

// The caller's place in the cellar: owner, a member with a role, or nobody.
function cellarWith({ owner = OTHER_ID, members = [], deletedAt = null } = {}) {
  return { _id: CELLAR_ID, name: 'Main', user: owner, members, deletedAt };
}

function expectNothingDone() {
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(Bottle).not.toHaveBeenCalled();
  expect(ImportSession.deleteMany).not.toHaveBeenCalled();
  expect(ImportSession.find).not.toHaveBeenCalled();
  expect(ImportSession.__instances).toHaveLength(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  ImportSession.__instances.length = 0;
});

describe('a caller with no role in the cellar', () => {
  test.each(Object.keys(ROUTES))('%s answers 404 Cellar not found, like a missing cellar', async (route) => {
    Cellar.findById.mockResolvedValue(cellarWith({ members: [{ user: '64b000000000000000000003', role: 'editor' }] }));
    const res = await ROUTES[route]();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Cellar not found' });
    expectNothingDone();
  });
});

describe('a viewer of the cellar', () => {
  beforeEach(() => {
    Cellar.findById.mockResolvedValue(cellarWith({ members: [{ user: USER_ID, role: 'viewer' }] }));
  });

  test.each(WRITING_ROUTES)('%s answers 403 with the one import message', async (route) => {
    const res = await ROUTES[route]();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not authorized to import bottles to this cellar' });
    expectNothingDone();
  });

  test('listSessions answers 200 with the caller\'s own drafts', async () => {
    const res = await ROUTES.listSessions();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
    expect(ImportSession.find).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: USER_ID, status: 'draft' });
  });
});

describe('a soft-deleted cellar', () => {
  test.each(Object.keys(ROUTES))('%s answers 404 Cellar not found, even to its owner', async (route) => {
    Cellar.findById.mockResolvedValue(cellarWith({ owner: USER_ID, deletedAt: new Date('2026-10-01') }));
    const res = await ROUTES[route]();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Cellar not found' });
    expectNothingDone();
  });
});

describe('an editor of the cellar', () => {
  beforeEach(() => {
    Cellar.findById.mockResolvedValue(cellarWith({ members: [{ user: USER_ID, role: 'editor' }] }));
  });

  test('createSession saves the draft', async () => {
    const res = await ROUTES.createSession();
    expect(res.status).toBe(201);
    expect(ImportSession.deleteMany).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: USER_ID, status: 'draft' });
    expect(ImportSession.__instances).toHaveLength(1);
    expect(ImportSession.__instances[0].save).toHaveBeenCalled();
  });

  test('listSessions answers 200', async () => {
    const res = await ROUTES.listSessions();
    expect(res.status).toBe(200);
  });
});
