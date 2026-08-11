/**
 * Grape regionalNames on the REST admin surface (somm ticket: "Tinta Roriz
 * stored as Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * regionalNames are ref-bearing display data — Mongoose validates neither
 * that the ids exist nor that a region belongs to its entry's country, and a
 * duplicate (country, region) pair would make display resolution
 * order-dependent. The validator carries those invariants; the PUT wiring
 * test pins that the route honours a rejection (400, nothing saved) and that
 * an accepted change resyncs the WINES search index (regional names feed its
 * grapeNames) without the bottles resync a rename needs.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(),
  fullSync: jest.fn(),
  fullSyncBottles: jest.fn(),
  waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/Country', () => ({ exists: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn() }));
jest.mock('../../models/Grape', () => ({ findById: jest.fn(), find: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const searchService = require('../../services/search');
const router = require('./taxonomy');
const { validateGrapeRegionalNames } = router;

const ADMIN_ID = '64b000000000000000000001';
const GRAPE_ID = '64b00000000000000000009e';
const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);
const ALENTEJO = 'c'.repeat(24);

const regionDoc = (id, country, name) => ({ _id: id, name, country });

beforeEach(() => {
  jest.clearAllMocks();
  Country.exists.mockResolvedValue({ _id: PORTUGAL });
  Region.findById.mockImplementation((id) => ({
    select: () => ({
      lean: async () => (String(id) === DOURO ? regionDoc(DOURO, PORTUGAL, 'Douro') : null),
    }),
  }));
});

describe('validateGrapeRegionalNames', () => {
  test('accepts a valid set (region entry + country-only entry) and returns it cleaned', async () => {
    const res = await validateGrapeRegionalNames([
      { country: PORTUGAL, region: DOURO, name: '  Tinta Roriz ' },
      { country: PORTUGAL, name: 'Aragonez' },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.value).toEqual([
      { country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' },
      { country: PORTUGAL, region: null, name: 'Aragonez' },
    ]);
  });

  test('rejects a region that belongs to a different country', async () => {
    Region.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => regionDoc(DOURO, 'f'.repeat(24), 'Douro') }),
    }));
    const res = await validateGrapeRegionalNames([{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }]);
    expect(res.error).toMatch(/different country/);
  });

  test('rejects duplicate (country, region) pairs — including two country-level entries', async () => {
    const dupRegion = await validateGrapeRegionalNames([
      { country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' },
      { country: PORTUGAL, region: DOURO, name: 'Aragonez' },
    ]);
    expect(dupRegion.error).toMatch(/Duplicate/);
    const dupCountry = await validateGrapeRegionalNames([
      { country: PORTUGAL, name: 'Tinta Roriz' },
      { country: PORTUGAL, name: 'Aragonez' },
    ]);
    expect(dupCountry.error).toMatch(/Duplicate/);
    // Same country, DIFFERENT regions is legitimate — Douro + Alentejo.
    Region.findById.mockImplementation((id) => ({
      select: () => ({
        lean: async () => regionDoc(String(id), PORTUGAL, String(id) === DOURO ? 'Douro' : 'Alentejo'),
      }),
    }));
    const ok = await validateGrapeRegionalNames([
      { country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' },
      { country: PORTUGAL, region: ALENTEJO, name: 'Aragonez' },
    ]);
    expect(ok.error).toBeUndefined();
  });

  test('rejects missing/unknown refs and never queries with raw body junk', async () => {
    expect((await validateGrapeRegionalNames([{ name: 'X' }])).error).toMatch(/valid country id/);
    expect((await validateGrapeRegionalNames([{ country: { $ne: null }, name: 'X' }])).error).toMatch(/valid country id/);
    expect(Country.exists).not.toHaveBeenCalled(); // operator object never reached a query
    Country.exists.mockResolvedValue(null);
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, name: 'X' }])).error).toMatch(/No country/);
    Country.exists.mockResolvedValue({ _id: PORTUGAL });
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, region: ALENTEJO, name: 'X' }])).error)
      .toMatch(/No region/); // the beforeEach Region mock only knows DOURO
  });

  test('bounds: name 1–60 after trim, at most 20 entries, array-of-objects only', async () => {
    expect((await validateGrapeRegionalNames('Tinta Roriz')).error).toMatch(/array/);
    expect((await validateGrapeRegionalNames([null])).error).toMatch(/array of \{ country/);
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, name: '   ' }])).error).toMatch(/non-empty name/);
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, name: 'a'.repeat(61) }])).error).toMatch(/60 characters/);
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, name: 'a'.repeat(60) }])).error).toBeUndefined();
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ country: PORTUGAL, name: `n${i}` }));
    expect((await validateGrapeRegionalNames(tooMany)).error).toMatch(/At most 20/);
  });

  test('an empty array is valid — it clears the grape\'s regional names', async () => {
    expect(await validateGrapeRegionalNames([])).toEqual({ value: [] });
  });
});

// ── PUT wiring ───────────────────────────────────────────────────────────────

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');
const put = (path, body) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

describe('PUT /grapes/:id regionalNames wiring', () => {
  const grapeDoc = () => ({
    _id: GRAPE_ID,
    name: 'Tempranillo',
    regionalNames: [],
    save: jest.fn().mockResolvedValue(undefined),
  });

  test('a rejected payload → 400 with the validator\'s message, nothing saved', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      regionalNames: [
        { country: PORTUGAL, name: 'Tinta Roriz' },
        { country: PORTUGAL, name: 'Aragonez' },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Duplicate/);
    expect(grape.save).not.toHaveBeenCalled();
    expect(grape.regionalNames).toEqual([]);
  });

  test('a valid set saves, and resyncs the WINES index only (no rename → no bottles resync)', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(res.status).toBe(200);
    expect(grape.regionalNames).toEqual([{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }]);
    expect(grape.save).toHaveBeenCalled();
    expect(searchService.fullSync).toHaveBeenCalled();
    expect(searchService.fullSyncBottles).not.toHaveBeenCalled();
  });

  test('an update that does not touch regionalNames triggers no resync at all', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, { origin: 'Rioja, Spain' });
    expect(res.status).toBe(200);
    expect(searchService.fullSync).not.toHaveBeenCalled();
    expect(searchService.fullSyncBottles).not.toHaveBeenCalled();
  });
});
