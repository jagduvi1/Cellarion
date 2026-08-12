/**
 * /api/somm/pending-wines — the REST half of the pending-identity queue.
 *
 * Pins the ROUTE MATRIX (a plain user is 403, somm and admin are 200), the
 * ANONYMISATION contract (no creator identity ever leaves the server — the
 * #930 rule, and this payload also travels over MCP), the refusal to edit a row
 * that is no longer pending (409, not 404 — the id is real), the audit event,
 * and the promotion follow-through: a completed identity must (re)enter
 * Meilisearch, be re-embedded, and re-seed its maturity rows, because it was
 * excluded from all three while pending.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ find: jest.fn(), distinct: jest.fn() }));
jest.mock('../../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/search', () => ({
  indexWine: jest.fn().mockResolvedValue(undefined),
  bulkIndexBottles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/embeddingJob', () => ({
  reembedActiveVintages: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/findOrCreateWine', () => ({
  findOrCreateRegion: jest.fn().mockResolvedValue({ _id: 'region-1' }),
}));
// The write path's cross-field pre-flight (a producer that is really a region /
// grape / placeholder is refused). Its own gating is pinned in
// services/pendingWineOps.identityGates.test.js; here it must simply not reach
// for the taxonomy collections.
jest.mock('../../services/crossFieldScan', () => ({
  detectCrossFieldForValues: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20,
  GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const BottleImage = require('../../models/BottleImage');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { logAudit } = require('../../services/audit');
const searchService = require('../../services/search');
const { reembedActiveVintages } = require('../../services/embeddingJob');
const { ensurePendingVintageProfile } = require('../../utils/vintageProfile');
const { resolveGrapeIdsStrict } = require('../../services/wineProfileOps');
const router = require('./pendingWines');

const oid = (c) => c.repeat(24);
const W1 = oid('a');
const CREATOR = oid('9');
const SCAN = oid('5');
const IMG = oid('6');
const BOTTLE = oid('7');

const tokenFor = (roles) => jwt.sign({ id: oid('1'), roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/somm/pending-wines', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const leanChain = (rows) => {
  const chain = {
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    populate: jest.fn(() => chain),
    select: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(rows),
  };
  return chain;
};

const WINE_ROW = {
  _id: W1,
  name: 'Kaefferkopf',
  producer: '',
  appellation: null,
  region: { name: 'Alsace' },
  country: { name: 'France' },
  grapes: [{ name: 'Riesling' }],
  type: 'white',
  createdAt: new Date('2026-08-11T09:00:00Z'),
  createdVia: 'ui',
  createdBy: CREATOR,          // must NOT reach the payload
  scanImage: SCAN,
};

/** A savable wine doc whose save() runs the real promotion rule. */
const wineDoc = (over = {}) => {
  const doc = {
    _id: W1,
    name: 'Kaefferkopf',
    producer: '',
    appellation: null,
    type: 'white',
    country: 'country-1',
    region: null,
    grapes: [],
    slug: 'kaefferkopf',
    pendingIdentity: true,
    ...over,
  };
  doc.save = jest.fn(async () => {
    // Mirror the model hook: a real producer + name promotes.
    if (doc.pendingIdentity && doc.producer && doc.producer.trim() && doc.name) {
      doc.pendingIdentity = false;
    }
    return doc;
  });
  return doc;
};

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(leanChain([WINE_ROW]));
  WineDefinition.countDocuments.mockResolvedValue(1);
  Bottle.find.mockReturnValue(leanChain([{ _id: BOTTLE, wineDefinition: W1 }]));
  Bottle.distinct.mockResolvedValue(['2019']);
  BottleImage.find.mockImplementation((q) => {
    // Two different queries: the bottle-photo lookup ($or) and the scan lookup.
    if (q && q.$or) return leanChain([{ _id: IMG, bottle: BOTTLE, originalUrl: '/api/uploads/originals/x.jpg' }]);
    return leanChain([{ _id: SCAN, originalUrl: '/api/uploads/originals/scan.jpg' }]);
  });
  resolveGrapeIdsStrict.mockResolvedValue({ ok: true, ids: ['g1'], names: ['Riesling'] });
  Country.findOne.mockResolvedValue({ _id: 'country-1' });
});

const get = (token, qs = '') => fetch(`${baseUrl}/api/somm/pending-wines${qs}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const patch = (token, id, body) => fetch(`${baseUrl}/api/somm/pending-wines/${id}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('auth matrix', () => {
  test('a plain user is 403 on both verbs', async () => {
    const token = tokenFor(['user']);
    expect((await get(token)).status).toBe(403);
    expect((await patch(token, W1, { producer: 'X' })).status).toBe(403);
  });

  test('no token is 401', async () => {
    expect((await fetch(`${baseUrl}/api/somm/pending-wines`)).status).toBe(401);
  });

  test.each([['somm'], ['admin']])('%s gets the queue', async (role) => {
    expect((await get(tokenFor([role]))).status).toBe(200);
  });
});

describe('GET — projection and anonymisation', () => {
  test('returns the wine, its images and its bottle count — and NO creator', async () => {
    const res = await get(tokenFor(['somm']));
    const body = await res.json();

    expect(body.wines).toHaveLength(1);
    const row = body.wines[0];
    expect(row).toMatchObject({
      name: 'Kaefferkopf',
      producer: null,             // '' surfaces as null, never an empty quoted string
      regionName: 'Alsace',
      countryName: 'France',
      grapeNames: ['Riesling'],
      createdVia: 'ui',
      bottleCount: 1,
      scanImageId: String(SCAN),
    });
    expect(row.bottleImageIds).toEqual([String(IMG)]);

    // The privacy line of the feature, asserted on the SERIALIZED payload so a
    // future field rename cannot sneak an identity through.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(CREATOR);
    expect(raw).not.toMatch(/createdBy|username|email/i);
  });

  test('createdVia filter is applied from the static allowlist only', async () => {
    await get(tokenFor(['somm']), '?createdVia=import');
    expect(WineDefinition.find).toHaveBeenCalledWith(
      expect.objectContaining({ pendingIdentity: true, createdVia: 'import' }));

    jest.clearAllMocks();
    WineDefinition.find.mockReturnValue(leanChain([]));
    WineDefinition.countDocuments.mockResolvedValue(0);
    await get(tokenFor(['somm']), '?createdVia=' + encodeURIComponent('{"$ne":null}'));
    expect(WineDefinition.find).toHaveBeenCalledWith({ pendingIdentity: true });
  });
});

describe('PATCH — fix, promote, audit', () => {
  test('completing producer + name promotes and runs the whole follow-through', async () => {
    const doc = wineDoc();
    WineDefinition.findById.mockResolvedValue(doc);

    const res = await patch(tokenFor(['somm']), W1, {
      producer: 'Cave de Kaysersberg', name: 'Kaefferkopf', countryName: 'France',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.promoted).toBe(true);
    expect(body.wine.pendingIdentity).toBe(false);
    expect(doc.producer).toBe('Cave de Kaysersberg');
    // normalizedKey regenerated from the completed identity — this is what
    // moves the row out of the pending key namespace.
    expect(doc.normalizedKey).toBe('cave de kaysersberg:kaefferkopf:');

    // Everything the row was excluded from while pending, let back in:
    expect(searchService.indexWine).toHaveBeenCalledWith(W1);
    expect(reembedActiveVintages).toHaveBeenCalledWith(W1);
    expect(ensurePendingVintageProfile).toHaveBeenCalledWith(W1, '2019');
  });

  test('a partial fix that leaves the producer empty does NOT promote', async () => {
    const doc = wineDoc();
    WineDefinition.findById.mockResolvedValue(doc);

    const res = await patch(tokenFor(['somm']), W1, { appellation: 'Kaefferkopf' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.promoted).toBe(false);
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('the audit event carries the field diff and the promotion outcome', async () => {
    WineDefinition.findById.mockResolvedValue(wineDoc());

    await patch(tokenFor(['admin']), W1, { producer: 'Cave de Kaysersberg' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      'wine.pending_fix',
      { type: 'wine', id: W1 },
      expect.objectContaining({
        fields: ['producer'],
        promoted: true,
        diff: expect.objectContaining({ producer: { from: null, to: 'Cave de Kaysersberg' } }),
      }),
    );
  });

  test('a wine that is no longer pending is a 409, not a 404 — the id IS real', async () => {
    WineDefinition.findById.mockResolvedValue(wineDoc({ pendingIdentity: false, producer: 'X' }));

    const res = await patch(tokenFor(['somm']), W1, { producer: 'Y' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not in the pending-identity queue/);
  });

  test('a missing wine is a 404', async () => {
    WineDefinition.findById.mockResolvedValue(null);
    expect((await patch(tokenFor(['somm']), W1, { producer: 'Y' })).status).toBe(404);
  });

  test('an empty patch is a 400', async () => {
    expect((await patch(tokenFor(['somm']), W1, {})).status).toBe(400);
  });

  test('producer cannot be EMPTIED — this queue exists to fill it', async () => {
    const res = await patch(tokenFor(['somm']), W1, { producer: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be emptied/);
  });

  test('an unknown country is a 400 and mints nothing', async () => {
    Country.findOne.mockResolvedValue(null);
    WineDefinition.findById.mockResolvedValue(wineDoc());

    const res = await patch(tokenFor(['somm']), W1, { producer: 'Cave de Kaysersberg',countryName: 'Atlantis' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown country/);
  });

  test('an unknown grape is a 400 — varieties are never minted from this queue', async () => {
    resolveGrapeIdsStrict.mockResolvedValue({ ok: false, unmatched: ['Nonsensegrape'] });
    WineDefinition.findById.mockResolvedValue(wineDoc());

    const res = await patch(tokenFor(['somm']), W1, { producer: 'Cave de Kaysersberg',grapeNames: ['Nonsensegrape'] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Not in the grape taxonomy/);
  });

  test('a duplicate-identity save is a 409 telling the curator to merge', async () => {
    const doc = wineDoc();
    doc.save = jest.fn(async () => { const e = new Error('dup'); e.code = 11000; throw e; });
    WineDefinition.findById.mockResolvedValue(doc);

    const res = await patch(tokenFor(['somm']), W1, { producer: 'Cave de Kaysersberg' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/merge them instead/);
  });
});
