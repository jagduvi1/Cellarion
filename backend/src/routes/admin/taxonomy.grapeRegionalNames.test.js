/**
 * Grape regionalNames on the REST admin surface (somm ticket: "Tinta Roriz
 * stored as Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * regionalNames are ref-bearing display data — Mongoose validates neither
 * that the ids exist nor that a region belongs to its entry's country, and a
 * duplicate (country, region) pair would make display resolution
 * order-dependent. The validator carries those invariants; the wiring tests
 * pin that the routes honour a rejection (400, nothing saved), that an
 * accepted change resyncs BOTH search indexes (regional names feed the
 * grapeNames of the wines AND bottles documents — audit 2026-08-11), that
 * both write routes return the non-blocking curator-trap warnings, and that
 * a region referenced by a grape's regional name refuses deletion.
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
jest.mock('../../models/Country', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn() }));
// Constructor + statics: the POST route instantiates `new Grape(...)`.
jest.mock('../../models/Grape', () => {
  const Grape = jest.fn(function (fields) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
  Grape.findById = jest.fn();
  Grape.find = jest.fn();
  Grape.exists = jest.fn();
  return Grape;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const WineDefinition = require('../../models/WineDefinition');
const Grape = require('../../models/Grape');
const searchService = require('../../services/search');
const router = require('./taxonomy');
const { validateGrapeRegionalNames, computeRegionalNameWarnings } = router;

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
  Region.countDocuments.mockResolvedValue(0);
  WineDefinition.countDocuments.mockResolvedValue(0);
  Grape.exists.mockResolvedValue(null);
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

  test('names get the sanitizeTaxonomyName fold grape.name gets: control chars stripped, whitespace collapsed', async () => {
    const res = await validateGrapeRegionalNames([
      { country: PORTUGAL, name: 'Tinta' + String.fromCharCode(0, 7) + '  Roriz\n' },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.value[0].name).toBe('Tinta Roriz');
    // All-control input folds to empty and is rejected like a blank name.
    expect((await validateGrapeRegionalNames([{ country: PORTUGAL, name: String.fromCharCode(0, 1) }])).error)
      .toMatch(/non-empty name/);
  });
});

// ── Curator-trap warnings (pure) ─────────────────────────────────────────────
// A regional name that is not also a synonym displays fine but cannot be
// written back via set_wine_profile (resolveGrapeIdsStrict matches
// normalizedName + normalizedSynonyms only) — the check must run the exact
// fold that write path runs, and it must flag, never block.

describe('computeRegionalNameWarnings', () => {
  const entries = (...names) => names.map((name) => ({ country: PORTUGAL, region: null, name }));

  test('a name that is neither the grape nor a synonym warns, with the exact curator-facing message', () => {
    const w = computeRegionalNameWarnings(entries('Tinta Roriz'), {
      name: 'Tempranillo', normalizedName: 'tempranillo', synonyms: [],
    });
    expect(w).toEqual([
      "'Tinta Roriz' is not a synonym of Tempranillo — curators cannot write it back via set_wine_profile; add it as a synonym too",
    ]);
  });

  test('a synonym match silences the warning — diacritic/case-insensitively', () => {
    const w = computeRegionalNameWarnings(entries('Tinta Roriz'), {
      name: 'Tempranillo', normalizedName: 'tempranillo', synonyms: ['TINTA RORÍZ'],
    });
    expect(w).toEqual([]);
  });

  test('the static GRAPE_SYNONYMS hop counts as writable — "Aragonez" resolves to Tempranillo before the check', () => {
    // resolveGrapeName maps Aragonez → Tempranillo, exactly as the write path
    // would, so no synonym entry is needed for it.
    const w = computeRegionalNameWarnings(entries('Aragonez'), {
      name: 'Tempranillo', normalizedName: 'tempranillo', synonyms: [],
    });
    expect(w).toEqual([]);
  });

  test('a name that normalizes to nothing (non-Latin script) is not writable → warns', () => {
    const w = computeRegionalNameWarnings(entries('Ркацители'), {
      name: 'Rkatsiteli', normalizedName: 'rkatsiteli', synonyms: [],
    });
    expect(w).toHaveLength(1);
  });
});

// ── Route wiring ─────────────────────────────────────────────────────────────

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
const send = (method, path, body) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const put = (path, body) => send('PUT', path, body);
const post = (path, body) => send('POST', path, body);

describe('PUT /grapes/:id regionalNames wiring', () => {
  const grapeDoc = (over = {}) => ({
    _id: GRAPE_ID,
    name: 'Tempranillo',
    normalizedName: 'tempranillo',
    synonyms: [],
    regionalNames: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
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

  test('a valid set saves and resyncs BOTH indexes — bottle documents carry regional grape names too', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(res.status).toBe(200);
    expect(grape.regionalNames).toEqual([{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }]);
    expect(grape.save).toHaveBeenCalled();
    expect(searchService.fullSync).toHaveBeenCalled();
    // Audit 2026-08-11: buildBottleDocument shares wineGrapeSearchNames, so a
    // mapping change without this resync left cellar search missing the label.
    expect(searchService.fullSyncBottles).toHaveBeenCalled();
  });

  test('an update that does not touch regionalNames triggers no resync at all', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, { origin: 'Rioja, Spain' });
    expect(res.status).toBe(200);
    expect(searchService.fullSync).not.toHaveBeenCalled();
    expect(searchService.fullSyncBottles).not.toHaveBeenCalled();
  });

  test('a non-synonym regional name → 200 with regionalNameWarnings (flag, never block)', async () => {
    const grape = grapeDoc();
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regionalNameWarnings).toEqual([
      "'Tinta Roriz' is not a synonym of Tempranillo — curators cannot write it back via set_wine_profile; add it as a synonym too",
    ]);
    expect(grape.save).toHaveBeenCalled(); // saved anyway — non-blocking
  });

  test('the INCOMING synonyms are what count when the request changes them', async () => {
    const grape = grapeDoc(); // stored synonyms: []
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      synonyms: ['Tinta Roriz'],
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    const body = await res.json();
    expect(body.regionalNameWarnings).toBeUndefined();
  });

  test('the stored doc\'s synonyms count when the request leaves them alone', async () => {
    const grape = grapeDoc({ synonyms: ['Tinta Roriz'] });
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, {
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    const body = await res.json();
    expect(body.regionalNameWarnings).toBeUndefined();
  });

  test('no regionalNames in the request → no warnings field, even if stored entries are not synonyms', async () => {
    const grape = grapeDoc({
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    Grape.findById.mockResolvedValue(grape);
    const res = await put(`/grapes/${GRAPE_ID}`, { origin: 'Rioja, Spain' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.regionalNameWarnings).toBeUndefined();
  });
});

describe('POST /grapes regionalNames wiring', () => {
  test('creating with a non-synonym regional name → 201 with regionalNameWarnings', async () => {
    const res = await post('/grapes', {
      name: 'Tempranillo',
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.grape.name).toBe('Tempranillo');
    expect(body.regionalNameWarnings).toEqual([
      "'Tinta Roriz' is not a synonym of Tempranillo — curators cannot write it back via set_wine_profile; add it as a synonym too",
    ]);
  });

  test('creating with the name also in synonyms → 201 and NO warnings field', async () => {
    const res = await post('/grapes', {
      name: 'Tempranillo',
      synonyms: ['Tinta Roriz'],
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.regionalNameWarnings).toBeUndefined();
  });
});

// ── Region DELETE guard ──────────────────────────────────────────────────────
// A region referenced by a grape's regional display name must refuse deletion
// (audit 2026-08-11): a dangling ref would silently drop curated display data.
// Merge is the supported path — mergeRegions re-points regionalNames.region.

describe('DELETE /regions/:id — grape regionalNames in-use guard', () => {
  const regionDelDoc = () => ({
    _id: DOURO,
    name: 'Douro',
    deleteOne: jest.fn().mockResolvedValue(undefined),
  });

  test('refuses deletion while a grape regional name references the region', async () => {
    const region = regionDelDoc();
    Region.findById.mockResolvedValue(region);
    Grape.exists.mockResolvedValue({ _id: GRAPE_ID });
    const res = await send('DELETE', `/regions/${DOURO}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/regional display name/);
    expect(Grape.exists).toHaveBeenCalledWith({ 'regionalNames.region': DOURO });
    expect(region.deleteOne).not.toHaveBeenCalled();
  });

  test('deletes normally when no grape references the region', async () => {
    const region = regionDelDoc();
    Region.findById.mockResolvedValue(region);
    const res = await send('DELETE', `/regions/${DOURO}`);
    expect(res.status).toBe(200);
    expect(region.deleteOne).toHaveBeenCalled();
  });
});

// ── Country DELETE guard ─────────────────────────────────────────────────────
// Same asymmetry the region guard closed (audit 2026-08-11 L-2): a country
// referenced only by a grape's country-level regional name must refuse
// deletion — a dangling ref bricks that grape's next regionalNames save.

describe('DELETE /countries/:id — grape regionalNames in-use guard', () => {
  const countryDelDoc = () => ({
    _id: PORTUGAL,
    name: 'Portugal',
    deleteOne: jest.fn().mockResolvedValue(undefined),
  });

  test('refuses deletion while a grape regional name references the country', async () => {
    const country = countryDelDoc();
    Country.findById.mockResolvedValue(country);
    Grape.exists.mockResolvedValue({ _id: GRAPE_ID });
    const res = await send('DELETE', `/countries/${PORTUGAL}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/regional display name/);
    expect(Grape.exists).toHaveBeenCalledWith({ 'regionalNames.country': PORTUGAL });
    expect(country.deleteOne).not.toHaveBeenCalled();
  });

  test('deletes normally when no grape references the country', async () => {
    const country = countryDelDoc();
    Country.findById.mockResolvedValue(country);
    const res = await send('DELETE', `/countries/${PORTUGAL}`);
    expect(res.status).toBe(200);
    expect(country.deleteOne).toHaveBeenCalled();
  });
});
