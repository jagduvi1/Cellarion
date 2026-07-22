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
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
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
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
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
