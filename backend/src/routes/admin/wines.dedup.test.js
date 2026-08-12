/**
 * POST /api/admin/wines — the duplicate gate.
 *
 * WHY THIS TEST EXISTS (registry duplicate analysis 2026-07-22, RC4): this
 * endpoint used to `new WineDefinition(...)` directly, bypassing step-0
 * canonicalization, sibling match and the fuzzy soft zone — only VERBATIM
 * duplicates were stopped by the unique key. The route now probes the shared
 * matcher (matchOnly) and 409s with candidates unless confirmCreate is given,
 * and stores canonicalized fields + createdVia provenance. This suite pins
 * that gate.
 *
 * It also pins the appellation CANONICALIZATION on both admin write surfaces
 * (POST and PUT): both write the WineDefinition directly rather than through
 * findOrCreateWine, so both must call the curated-registry resolver themselves
 * or the admin surfaces reintroduce spelling variants the mint path folds.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({}));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({}));
jest.mock('../../models/WineNotDuplicate', () => ({ find: jest.fn() }));
jest.mock('../../models/WineList', () => ({}));
jest.mock('../../models/WishlistItem', () => ({}));
jest.mock('../../models/PriceTrackingRequest', () => ({}));
jest.mock('../../models/PriceTrackingSkip', () => ({}));
jest.mock('../../models/CommunityWinePrice', () => ({}));
jest.mock('../../models/JournalEntry', () => ({}));
jest.mock('../../models/Recommendation', () => ({}));
jest.mock('../../models/RestockAlert', () => ({}));
jest.mock('../../models/WineRequest', () => ({}));
jest.mock('../../models/WineCorrectionProposal', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexBottles: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
// Identity by default so the tier-strip assertion below reads the
// normalizeAppellation output; the curated-registry test overrides it.
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const WineNotDuplicate = require('../../models/WineNotDuplicate');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const { generateWineKey } = require('../../utils/normalize');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const COUNTRY_ID = '64b0000000000000000000aa';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  Country.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'New Zealand' }) }),
  });
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
});

const postWine = (body) => fetch(`${baseUrl}/api/admin/wines`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

const BODY = {
  name: 'Felton Road Block 3 Pinot Noir',
  producer: 'Felton Road Wines Ltd',
  country: COUNTRY_ID,
  appellation: 'Bannockburn',
  type: 'red',
};

test('a probe hit returns 409 with candidates and creates nothing', async () => {
  const existing = { _id: 'wine-existing', name: 'Block 3 Pinot Noir', producer: 'Felton Road', appellation: 'Bannockburn' };
  findOrCreateWine.mockResolvedValue({ wine: existing, created: false });

  const res = await postWine(BODY);
  expect(res.status).toBe(409);
  const data = await res.json();
  expect(data.candidates).toEqual([
    { _id: 'wine-existing', name: 'Block 3 Pinot Noir', producer: 'Felton Road', appellation: 'Bannockburn', score: 1 },
  ]);
  expect(WineDefinition).not.toHaveBeenCalled();

  // The probe must run in matchOnly (never create) with the CANONICALIZED name
  // and the resolved country name (so the different-country guard can work).
  expect(findOrCreateWine).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Block 3 Pinot Noir', producer: 'Felton Road Wines Ltd', country: 'New Zealand' }),
    ADMIN_ID,
    { matchOnly: true }
  );
});

test('soft-zone probe candidates also 409', async () => {
  findOrCreateWine.mockResolvedValue({
    wine: null,
    candidates: [{ wine: { _id: 'w1', name: 'Block 3 Pinot Noir', producer: 'Felton Road', appellation: null }, score: 0.9 }],
  });

  const res = await postWine(BODY);
  expect(res.status).toBe(409);
  const data = await res.json();
  expect(data.candidates[0]).toMatchObject({ _id: 'w1', score: 0.9 });
  expect(WineDefinition).not.toHaveBeenCalled();
});

test('no probe hit creates with canonicalized fields + createdVia ui', async () => {
  const res = await postWine({ ...BODY, appellation: 'Bannockburn DOCG' });
  expect(res.status).toBe(201);

  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.name).toBe('Block 3 Pinot Noir'); // variant producer prefix stripped
  expect(doc.producer).toBe('Felton Road Wines Ltd');
  expect(doc.appellation).toBe('Bannockburn'); // tier suffix stripped
  expect(doc.createdVia).toBe('ui');
  expect(doc.normalizedKey).toBe(generateWineKey('Block 3 Pinot Noir', 'Felton Road Wines Ltd', 'Bannockburn'));
});

// The admin create writes the WineDefinition itself, so the curated-registry
// resolve has to happen HERE — one resolution serving the dedup probe, the
// normalizedKey and the stored field, or the admin surface reintroduces the
// spelling variants the mint chokepoint folds.
test('the STORED appellation is the resolver\'s canonical spelling, and the probe sees it too', async () => {
  resolveCanonicalAppellation.mockResolvedValueOnce('Yecla');

  const res = await postWine({ ...BODY, appellation: 'Yecla DO' });
  expect(res.status).toBe(201);

  expect(resolveCanonicalAppellation).toHaveBeenCalledWith('Yecla DO');
  const doc = WineDefinition.mock.calls[0][0];
  expect(doc.appellation).toBe('Yecla');
  expect(doc.normalizedKey).toBe(generateWineKey('Block 3 Pinot Noir', 'Felton Road Wines Ltd', 'Yecla'));
  expect(findOrCreateWine).toHaveBeenCalledWith(
    expect.objectContaining({ appellation: 'Yecla' }), ADMIN_ID, { matchOnly: true }
  );
});

// The PUT is the everyday admin edit surface and the second direct writer in
// this file — same rule, separately pinned.
test('PUT stores the resolver\'s canonical spelling and keys off it', async () => {
  resolveCanonicalAppellation.mockResolvedValueOnce('Bordeaux');
  const wine = {
    _id: 'wine-1', name: 'Le Petit', producer: 'Ch. Test', appellation: 'old',
    save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined),
  };
  WineDefinition.findById.mockResolvedValue(wine);
  Bottle.distinct.mockResolvedValue([]);

  const res = await fetch(`${baseUrl}/api/admin/wines/64b0000000000000000000b1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
    body: JSON.stringify({ appellation: '  Appellation Bordeaux Contrôlée  ' }),
  });
  expect(res.status).toBe(200);

  expect(resolveCanonicalAppellation).toHaveBeenCalledWith('Appellation Bordeaux Contrôlée');
  expect(wine.appellation).toBe('Bordeaux');
  expect(wine.normalizedKey).toBe(generateWineKey('Le Petit', 'Ch. Test', 'Bordeaux'));
});

test('confirmCreate skips the probe entirely (explicit "create anyway")', async () => {
  const res = await postWine({ ...BODY, confirmCreate: true });
  expect(res.status).toBe(201);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(WineDefinition).toHaveBeenCalled();
});

test('operator-injection shapes are rejected with 400, nothing queried', async () => {
  let res = await postWine({ ...BODY, name: { $gt: '' } });
  expect(res.status).toBe(400);

  res = await postWine({ ...BODY, country: { $ne: null } });
  expect(res.status).toBe(400);

  expect(Country.findById).not.toHaveBeenCalled();
  expect(WineDefinition).not.toHaveBeenCalled();
});

test('canonical-collisions groups by canonicalKey, flags likely false positives, sorts by bottles', async () => {
  const rows = [
    { _id: 'a', name: 'Garden Spritz', producer: 'Domaine Chandon', appellation: null, type: 'sparkling', country: { _id: 'c-us', name: 'United States' }, canonicalKey: 'chandon:garden spritz:', createdAt: 'd1', createdVia: null },
    { _id: 'b', name: 'Garden Spritz', producer: 'Bodegas Chandon', appellation: null, type: 'sparkling', country: { _id: 'c-ar', name: 'Argentina' }, canonicalKey: 'chandon:garden spritz:', createdAt: 'd2', createdVia: 'import' },
    { _id: 'solo', name: 'Solo Wine', producer: 'X', appellation: null, type: 'red', country: { _id: 'c-us', name: 'United States' }, canonicalKey: 'x:solo wine:', createdAt: 'd3', createdVia: null },
  ];
  WineDefinition.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
    }),
  });
  WineNotDuplicate.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
  Bottle.aggregate.mockResolvedValue([{ _id: 'b', count: 4 }]);

  const res = await fetch(`${baseUrl}/api/admin/wines/canonical-collisions`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.total).toBe(1); // the solo wine is not a collision
  expect(data.sets[0].flags).toContain('DIFF-COUNTRY');
  expect(data.sets[0].wines.map(w => w._id)).toEqual(['b', 'a']); // most-bottled first
  expect(data.sets[0].wines[0].bottleCount).toBe(4);
});

test('canonical-collisions hides sets where every pair was dismissed as not-a-duplicate', async () => {
  const rows = [
    { _id: 'a', name: 'W', producer: 'P1', appellation: null, type: 'red', country: { _id: 'c1', name: 'France' }, canonicalKey: 'p:w:', createdAt: 'd1', createdVia: null },
    { _id: 'b', name: 'W', producer: 'P2', appellation: null, type: 'red', country: { _id: 'c1', name: 'France' }, canonicalKey: 'p:w:', createdAt: 'd2', createdVia: null },
  ];
  WineDefinition.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
    }),
  });
  WineNotDuplicate.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ wineA: 'a', wineB: 'b' }]) }),
  });
  Bottle.aggregate.mockResolvedValue([]);

  const res = await fetch(`${baseUrl}/api/admin/wines/canonical-collisions`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  const data = await res.json();
  expect(data.total).toBe(0);
});
