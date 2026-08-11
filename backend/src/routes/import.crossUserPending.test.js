/**
 * H-3 — POST /api/bottles/import/validate must not offer a STRANGER's pending
 * wine as a match.
 *
 * The shape of the bug: a pendingIdentity row stores producer '' by
 * construction, and a CellarTracker export routinely has no producer column —
 * so the two scored 1.0 against each other. The user then picked the "match"
 * and /confirm attached their bottles to another person's hidden,
 * half-identified record, silently merging two strangers' registries.
 *
 * All three candidate strategies were open. Strategy 3 was the worst: its
 * `normalizedKey: { $regex: ':<name>:' }` is UNANCHORED, and the pending
 * namespace is `pending~<creatorId>:<name>:<appellation>` — which contains that
 * substring by construction, so pending rows matched *preferentially*.
 *
 * The gate is the shared creator-aware one, not a blanket exclusion: /confirm
 * passes allowPending and resolves to the caller's OWN pending row, so hiding
 * it at /validate would make the preview lie about what the commit will do.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  return model;
});
jest.mock('../models/Bottle', () => {
  function Bottle(data) { Object.assign(this, data); this.save = jest.fn().mockResolvedValue(this); }
  Bottle.find = jest.fn();
  return Bottle;
});
jest.mock('../models/WineRequest', () => function WineRequest() {});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const Cellar = require('../models/Cellar');

const oid = (c) => c.repeat(24);
const ME = oid('1');
const CELLAR = oid('c');

const tokenFor = (id, roles = ['user']) => jwt.sign({ id, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', require('./import'));
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

// Every candidate query returns nothing — this suite is about the FILTERS the
// route builds, which is where the vulnerability lived.
const emptyFind = () => ({
  populate: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    lean: jest.fn().mockResolvedValue([]),
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({
    _id: CELLAR, deletedAt: null, user: ME, members: [], toString: () => CELLAR,
  });
  WineDefinition.find.mockImplementation(emptyFind);
  WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
});

const validate = (token, items) => fetch(`${baseUrl}/api/bottles/import/validate`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ cellarId: CELLAR, items }),
});

// A CellarTracker-shaped row: name, no producer — exactly what scores 1.0
// against a pending row's empty producer.
const CT_ROW = { wineName: 'Kaefferkopf', producer: 'Cave de Kaysersberg', vintage: '2019' };

describe('H-3 — the candidate pool is scoped to wines the caller may see', () => {
  test('every WineDefinition.find candidate query carries the visibility clause', async () => {
    await validate(tokenFor(ME), [CT_ROW]);

    expect(WineDefinition.find).toHaveBeenCalled();
    for (const call of WineDefinition.find.mock.calls) {
      const filter = JSON.stringify(call[0]);
      // Either spread in directly, or nested under $and when the query already
      // uses $or (strategy 3) — both forms carry the same clause.
      expect(filter).toContain('pendingIdentity');
      expect(filter).toContain(ME); // …and the creator branch, for their own rows
    }
  });

  test('strategy 3 combines its key $or with the visibility $or under $and', async () => {
    await validate(tokenFor(ME), [CT_ROW]);

    // The unanchored `:<name>:` regex is what matched pending~<uid>:<name>:.
    const strategy3 = WineDefinition.find.mock.calls
      .map((c) => c[0])
      .find((f) => JSON.stringify(f).includes('normalizedKey'));

    expect(strategy3).toBeDefined();
    // Two $or keys in one object would silently drop the first — the guard is
    // that the key match and the visibility clause are $and-ed, not merged.
    expect(strategy3.$and).toBeDefined();
    expect(strategy3.$and).toHaveLength(2);
    expect(JSON.stringify(strategy3.$and[0])).toContain('normalizedKey');
    expect(strategy3.$and[1].$or).toEqual([
      { pendingIdentity: { $ne: true } },
      { pendingIdentity: true, createdBy: ME },
    ]);
  });

  test('a CURATOR sees everything — the clause collapses to nothing', async () => {
    // Same account (cellar access is a separate axis), somm role added.
    await validate(tokenFor(ME, ['somm']), [CT_ROW]);

    const strategy3 = WineDefinition.find.mock.calls
      .map((c) => c[0])
      .find((f) => JSON.stringify(f).includes('normalizedKey'));

    // No $and wrapper: with an empty clause the key match is used directly.
    expect(strategy3.$and).toBeUndefined();
    expect(strategy3.$or).toBeDefined();
  });

  test('the exact-key lookup needs no gate — a real producer can never key into pending~', async () => {
    await validate(tokenFor(ME), [CT_ROW]);
    // findExactRegistryWine queries a full normalizedKey built from a REAL
    // producer. normalizeString strips '~', so the pending namespace is
    // provably unreachable from it (models/WineDefinition pendingIdentity note).
    for (const call of WineDefinition.findOne.mock.calls) {
      expect(call[0].normalizedKey).toBeDefined();
      expect(String(call[0].normalizedKey)).not.toContain('pending~');
    }
  });
});
