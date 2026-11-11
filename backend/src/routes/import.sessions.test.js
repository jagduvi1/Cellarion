/**
 * The import draft sessions: POST, GET (list), GET /:id, PUT /:id and
 * DELETE /:id under /api/bottles/import/sessions.
 *
 * A draft holds a reviewed-but-not-yet-confirmed import so it can be resumed.
 * Pinned as the endpoints behave today:
 *   - one draft per user and cellar: creating one deletes the caller's earlier
 *     draft for that cellar first; what the client did not send gets defaults
 *   - a draft is its owner's: another user's is a 403; a malformed id, a
 *     missing session and one that is no longer a draft are a 404
 *   - opening a draft matches the rows left as "request" again, and offers a
 *     match only when it is confident and carries no style or colour conflict
 *   - an update changes only the fields that were sent
 *   - a delete removes the caller's session whatever its status
 *
 * Who may reach a cellar's sessions at all is pinned in
 * import.cellarAccess.test.js. Real router and requireAuth (HS256 test
 * tokens); the models and the matcher are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
// The matcher behind "is this requested wine in the registry by now?".
jest.mock('../services/importMatching', () => ({
  rowColourConflict: jest.fn(),
  findExactRegistryWine: jest.fn(),
  splitKnownProducerPrefix: jest.fn(),
  findWineMatches: jest.fn(),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => jest.fn());
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
  ImportSession.find = jest.fn();
  ImportSession.findById = jest.fn();
  return ImportSession;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const ImportSession = require('../models/ImportSession');
const { findWineMatches } = require('../services/importMatching');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';
const SESSION_ID = '64b0000000000000000000cc';
const BASE = '/api/bottles/import/sessions';

function request(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const headers = { authorization: `Bearer ${token}` };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ port: server.address().port, path: url, method, headers }, (res) => {
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

// A findById result that works both awaited and with .lean().
const found = (doc) => ({ lean: async () => doc, then: (res, rej) => Promise.resolve(doc).then(res, rej) });
const sessionDoc = (over = {}) => ({
  _id: SESSION_ID, user: USER_ID, cellar: CELLAR_ID, status: 'draft',
  results: [], selections: {},
  save: jest.fn().mockResolvedValue(undefined),
  deleteOne: jest.fn().mockResolvedValue(undefined),
  ...over,
});
const RESULTS = [{ index: 0, item: { wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' } }];

beforeEach(() => {
  jest.clearAllMocks();
  ImportSession.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
});

describe('POST /sessions', () => {
  test.each([
    ['no cellarId', { results: RESULTS }, 'Valid cellarId is required'],
    ['a malformed cellarId', { cellarId: 'nope', results: RESULTS }, 'Valid cellarId is required'],
    ['no results', { cellarId: CELLAR_ID }, 'results array is required'],
    ['an empty results list', { cellarId: CELLAR_ID, results: [] }, 'results array is required'],
  ])('%s is a 400 before the cellar is read', async (_label, body, error) => {
    const res = await request('POST', BASE, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(Cellar.findById).not.toHaveBeenCalled();
    expect(ImportSession.__instances).toHaveLength(0);
  });

  test("a new draft replaces the caller's earlier draft for the cellar, and what was not sent gets its default", async () => {
    const res = await request('POST', BASE, { cellarId: CELLAR_ID, results: RESULTS, ctTextFallback: 'not a list' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sessionId: '64b0000000000000000000ee' });

    expect(ImportSession.deleteMany).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: USER_ID, status: 'draft' });
    expect(ImportSession.__instances).toHaveLength(1);
    const draft = ImportSession.__instances[0];
    expect(ImportSession.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(draft.save.mock.invocationCallOrder[0]);
    expect(draft).toMatchObject({
      cellar: CELLAR_ID, user: USER_ID, results: RESULTS,
      selections: {}, manualWines: {}, positionAnchor: 'top-left', rackConfigs: {}, defaultCurrency: 'USD',
      importWarnings: [], ctTextFallback: [],
    });
    expect(draft.detectedEncoding).toBeUndefined();
    expect(draft.ctTable).toBeUndefined();
  });

  test('what the client sent is kept, with the parse warnings bounded to the fields the banner reads', async () => {
    const res = await request('POST', BASE, {
      cellarId: CELLAR_ID, results: RESULTS, fileName: 'cellar.csv', detectedFormat: 'cellartracker',
      selections: { 0: 'request' }, manualWines: { 0: { name: 'X' } }, positionAnchor: 'bottom-left',
      rackConfigs: { A: { rows: 4 } }, defaultCurrency: 'SEK', detectedEncoding: 'windows-1252', ctTable: 'List',
      ctTextFallback: ['Notes'],
      importWarnings: [{ code: 'ct-truncated', count: 3, sample: 'row 9', extra: { big: 'x' } }, 'junk'],
    });
    expect(res.status).toBe(201);
    expect(ImportSession.__instances[0]).toMatchObject({
      fileName: 'cellar.csv', detectedFormat: 'cellartracker',
      selections: { 0: 'request' }, manualWines: { 0: { name: 'X' } }, positionAnchor: 'bottom-left',
      rackConfigs: { A: { rows: 4 } }, defaultCurrency: 'SEK', detectedEncoding: 'windows-1252', ctTable: 'List',
      ctTextFallback: ['Notes'],
      importWarnings: [{ code: 'ct-truncated', count: 3, sample: 'row 9' }],
    });
  });
});

describe('GET /sessions', () => {
  test('a malformed cellarId is a 400', async () => {
    const res = await request('GET', `${BASE}?cellarId=nope`);
    expect(res.status).toBe(400);
    expect(ImportSession.find).not.toHaveBeenCalled();
  });

  test("lists the caller's drafts for the cellar, newest first, with the four fields the list shows", async () => {
    const chain = {};
    chain.select = jest.fn(() => chain);
    chain.sort = jest.fn(() => chain);
    chain.lean = jest.fn(async () => [{ _id: SESSION_ID, fileName: 'cellar.csv' }]);
    ImportSession.find.mockReturnValue(chain);

    const res = await request('GET', `${BASE}?cellarId=${CELLAR_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [{ _id: SESSION_ID, fileName: 'cellar.csv' }] });
    expect(ImportSession.find).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: USER_ID, status: 'draft' });
    expect(chain.select).toHaveBeenCalledWith('fileName detectedFormat createdAt updatedAt');
    expect(chain.sort).toHaveBeenCalledWith({ updatedAt: -1 });
  });
});

describe('GET /sessions/:id', () => {
  test('a malformed id, a missing session and one that is no longer a draft are all 404', async () => {
    expect((await request('GET', `${BASE}/nope`)).status).toBe(404);
    expect(ImportSession.findById).not.toHaveBeenCalled();

    ImportSession.findById.mockReturnValue(found(null));
    expect((await request('GET', `${BASE}/${SESSION_ID}`)).body).toEqual({ error: 'Session not found' });

    ImportSession.findById.mockReturnValue(found(sessionDoc({ status: 'completed' })));
    expect((await request('GET', `${BASE}/${SESSION_ID}`)).status).toBe(404);
  });

  test("another user's draft is a 403, and nothing is matched", async () => {
    ImportSession.findById.mockReturnValue(found(sessionDoc({ user: OTHER_ID, selections: { 0: 'request' }, results: RESULTS })));
    const res = await request('GET', `${BASE}/${SESSION_ID}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not authorized' });
    expect(findWineMatches).not.toHaveBeenCalled();
  });

  test('rows left as "request" are matched again; only a confident match with no conflict is offered', async () => {
    const item = (name) => ({ wineName: name, producer: 'P' });
    const wine = { _id: 'w-9', name: 'Barolo', producer: 'Pira', country: { name: 'Italy' }, region: { name: 'Piedmont' }, appellation: 'Barolo', type: 'red' };
    ImportSession.findById.mockReturnValue(found(sessionDoc({
      selections: { 0: 'request', 1: 'w-1', 2: 'request', 3: 'request', 4: 'request', 5: 'request', 6: 'request' },
      results: [
        { index: 0, item: item('now in the registry') },
        { index: 1, item: item('already chosen') },
        { index: 2, item: item('a range sibling') },
        { index: 3, item: item('the other colour') },
        { index: 4, item: item('not confident') },
        { index: 5, item: item('the matcher fails') },
        // index 6 has a selection but no stored row.
      ],
    })));
    findWineMatches.mockImplementation(async (it) => {
      if (it.wineName === 'now in the registry') return [{ wine, score: 0.9678 }];
      if (it.wineName === 'a range sibling') return [{ wine, score: 0.99, styleConflict: 'Reserva' }];
      if (it.wineName === 'the other colour') return [{ wine, score: 0.99, colourConflict: 'white' }];
      if (it.wineName === 'not confident') return [{ wine, score: 0.94 }];
      throw new Error('search is down');
    });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request('GET', `${BASE}/${SESSION_ID}`);
    quiet.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.refreshed).toEqual({
      0: { wineId: 'w-9', name: 'Barolo', producer: 'Pira', country: 'Italy', region: 'Piedmont', appellation: 'Barolo', type: 'red', score: 0.97 },
    });
    expect(res.body.session).toMatchObject({ _id: SESSION_ID, status: 'draft' });
    // Only the rows left as "request" that have a stored row, as the caller sees the registry.
    expect(findWineMatches).toHaveBeenCalledTimes(5);
    expect(findWineMatches).toHaveBeenCalledWith(item('now in the registry'), { userId: USER_ID, roles: ['user'] });
    expect(findWineMatches.mock.calls.map((c) => c[0].wineName)).not.toContain('already chosen');
  });
});

describe('PUT /sessions/:id', () => {
  test('a malformed id, a missing session and one that is no longer a draft are 404; another user\'s is a 403', async () => {
    expect((await request('PUT', `${BASE}/nope`, {})).status).toBe(404);

    ImportSession.findById.mockReturnValue(found(null));
    expect((await request('PUT', `${BASE}/${SESSION_ID}`, {})).status).toBe(404);

    ImportSession.findById.mockReturnValue(found(sessionDoc({ status: 'completed' })));
    expect((await request('PUT', `${BASE}/${SESSION_ID}`, {})).status).toBe(404);

    const theirs = sessionDoc({ user: OTHER_ID });
    ImportSession.findById.mockReturnValue(found(theirs));
    expect((await request('PUT', `${BASE}/${SESSION_ID}`, { selections: { 0: 'w-1' } })).status).toBe(403);
    expect(theirs.save).not.toHaveBeenCalled();
  });

  test('only the fields that were sent change, the warnings are bounded, and the session is saved', async () => {
    const draft = sessionDoc({
      results: RESULTS, selections: { 0: 'request' }, manualWines: { 0: { name: 'kept' } },
      positionAnchor: 'top-left', rackConfigs: { A: 1 }, defaultCurrency: 'USD', importWarnings: [], detectedEncoding: 'utf-8',
    });
    ImportSession.findById.mockReturnValue(found(draft));

    const res = await request('PUT', `${BASE}/${SESSION_ID}`, {
      selections: { 0: 'w-1' }, defaultCurrency: 'EUR',
      importWarnings: [{ code: 'ct-truncated', count: 2, junk: true }],
      results: 'not a list',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(draft).toMatchObject({
      selections: { 0: 'w-1' }, defaultCurrency: 'EUR', importWarnings: [{ code: 'ct-truncated', count: 2 }],
      // Not sent, or not a list where a list is needed: left as it was.
      results: RESULTS, manualWines: { 0: { name: 'kept' } }, positionAnchor: 'top-left', rackConfigs: { A: 1 }, detectedEncoding: 'utf-8',
    });
    expect(draft.save).toHaveBeenCalledTimes(1);
  });

  test('a rewritten results list replaces the stored one', async () => {
    const draft = sessionDoc({ results: RESULTS });
    ImportSession.findById.mockReturnValue(found(draft));
    const rewritten = [{ index: 0, item: { wineName: 'Clos du Test', producer: 'Domaine Fictif' }, status: 'exact' }];
    expect((await request('PUT', `${BASE}/${SESSION_ID}`, { results: rewritten })).status).toBe(200);
    expect(draft.results).toEqual(rewritten);
  });
});

describe('DELETE /sessions/:id', () => {
  test('a malformed id and a missing session are 404; another user\'s is a 403', async () => {
    expect((await request('DELETE', `${BASE}/nope`)).status).toBe(404);

    ImportSession.findById.mockReturnValue(found(null));
    expect((await request('DELETE', `${BASE}/${SESSION_ID}`)).status).toBe(404);

    const theirs = sessionDoc({ user: OTHER_ID });
    ImportSession.findById.mockReturnValue(found(theirs));
    expect((await request('DELETE', `${BASE}/${SESSION_ID}`)).status).toBe(403);
    expect(theirs.deleteOne).not.toHaveBeenCalled();
  });

  test("removes the caller's session whatever its status", async () => {
    for (const status of ['draft', 'completed']) {
      const mine = sessionDoc({ status });
      ImportSession.findById.mockReturnValue(found(mine));
      const res = await request('DELETE', `${BASE}/${SESSION_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mine.deleteOne).toHaveBeenCalledTimes(1);
    }
  });
});
