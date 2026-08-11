/**
 * The read/write gates the pending-identity security audit found open, on the
 * REST side. One file because the finding is one finding: "a pendingIdentity
 * row must not reach anybody but its creator and curation" was enforced on the
 * wine routes and forgotten everywhere else.
 *
 *   H-2  GET /api/journal/wine-search — a regex over the WHOLE registry,
 *        .limit(200), returning ids. Authenticated but otherwise ungated: it
 *        handed out the very pending ids the other holes then accepted.
 *   H-5  POST /api/discussions — discussions are optionalAuth, their wine is
 *        populated into the response, indexed into the anonymously-searchable
 *        discussion index, and rendered for CRAWLERS by routes/og.js. Refused
 *        at WRITE time, which closes all three reads at once.
 *   H-5  Wine lists — a published list is served by routes/wineListPublic.js
 *        with NO auth at all.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findOne: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');

const oid = (c) => c.repeat(24);
const ME = oid('1');
const token = jwt.sign({ id: ME, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/journal', require('./journal'));
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => jest.clearAllMocks());

describe('H-2 — GET /api/journal/wine-search is no longer a full-registry sieve', () => {
  test('the query carries BOTH exclusions, matching routes/wines.js mongoSearch', async () => {
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    });

    const res = await fetch(`${baseUrl}/api/journal/wine-search?q=kaefferkopf`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(WineDefinition.find).toHaveBeenCalledWith(expect.objectContaining({
      pendingIdentity: { $ne: true },
      nonWine: { $ne: true },
    }));
  });

  test('with no registry match the bottle lookup never runs (no id to leak either way)', async () => {
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    });

    const res = await fetch(`${baseUrl}/api/journal/wine-search?q=kaefferkopf`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(await res.json()).toEqual({ bottles: [], wines: [] });
    expect(Bottle.find).not.toHaveBeenCalled();
  });

  test('a query shorter than 2 chars short-circuits before any query', async () => {
    const res = await fetch(`${baseUrl}/api/journal/wine-search?q=k`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await res.json()).toEqual({ bottles: [], wines: [] });
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });
});
