/**
 * POST /api/admin/wines/:id/non-wine — the quarantine toggle (registry audit
 * 2026-07-26, policy: keep non-wine rows, hide them). Pins: the flag round-trips
 * through save + a self-healing indexWine call, the mutation is audited, bad
 * input never touches the DB — and the name-check scan pool excludes flagged
 * rows at the QUERY level (a whisky must not pair against wines in any scan).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  ctor.bulkWrite = jest.fn();
  ctor.updateMany = jest.fn();
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
jest.mock('../../models/WineEmbedding', () => ({ deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) }));
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
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn(), reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { ensurePendingVintageProfile } = require('../../utils/vintageProfile');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000c1';
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
  Bottle.aggregate.mockResolvedValue([]);
});

const toggle = (id, body) => fetch(`${baseUrl}/api/admin/wines/${id}/non-wine`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

const wineDoc = () => {
  const doc = { _id: WINE_ID, name: 'Blue Label', producer: 'Johnnie Walker', nonWine: false };
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

test('quarantines a row: sets the flag, saves, self-heals the index, audits', async () => {
  const doc = wineDoc();
  WineDefinition.findById.mockResolvedValue(doc);

  const res = await toggle(WINE_ID, { value: true });
  expect(res.status).toBe(200);
  expect((await res.json()).nonWine).toBe(true);
  expect(doc.nonWine).toBe(true);
  expect(doc.save).toHaveBeenCalled();
  expect(searchService.indexWine).toHaveBeenCalledWith(WINE_ID);
  expect(logAudit).toHaveBeenCalledWith(
    expect.anything(), 'admin.wine.nonWine',
    { type: 'wine', id: WINE_ID },
    expect.objectContaining({ value: true, name: 'Blue Label' })
  );
  // A quarantine seeds nothing — the queue rows are what it takes away.
  expect(ensurePendingVintageProfile).not.toHaveBeenCalled();
  // Its vectors go too (audit 2026-10-14): semantic search and the
  // similar-wines graph must not keep a row keyword search dropped.
  expect(require('../../models/WineEmbedding').deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
  expect(require('../../services/embeddingJob').reembedActiveVintages).not.toHaveBeenCalled();
});

test('restores a row with value: false and re-seeds the maturity queue from its bottles in cellars', async () => {
  const doc = { ...wineDoc(), nonWine: true };
  doc.save = jest.fn().mockResolvedValue(doc);
  WineDefinition.findById.mockResolvedValue(doc);
  Bottle.distinct.mockResolvedValue(['2019', 'NV']);

  const res = await toggle(WINE_ID, { value: false });
  expect(res.status).toBe(200);
  expect(doc.nonWine).toBe(false);
  expect(Bottle.distinct).toHaveBeenCalledWith('vintage', { wineDefinition: WINE_ID, status: 'active' });
  expect(ensurePendingVintageProfile.mock.calls).toEqual([[WINE_ID, '2019'], [WINE_ID, 'NV']]);
  // A restore re-embeds (the quarantine purged the vectors) and purges nothing.
  expect(require('../../services/embeddingJob').reembedActiveVintages).toHaveBeenCalledWith(WINE_ID);
  expect(require('../../models/WineEmbedding').deleteMany).not.toHaveBeenCalled();
});

test('a restore still answers 200 when the re-seed fails', async () => {
  const doc = { ...wineDoc(), nonWine: true };
  doc.save = jest.fn().mockResolvedValue(doc);
  WineDefinition.findById.mockResolvedValue(doc);
  Bottle.distinct.mockRejectedValue(new Error('db down'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const res = await toggle(WINE_ID, { value: false });
  expect(res.status).toBe(200);
  expect(doc.nonWine).toBe(false);
  warn.mockRestore();
});

test('setting false on a row that was never quarantined re-seeds nothing', async () => {
  WineDefinition.findById.mockResolvedValue(wineDoc());
  const res = await toggle(WINE_ID, { value: false });
  expect(res.status).toBe(200);
  expect(Bottle.distinct).not.toHaveBeenCalled();
  expect(require('../../services/embeddingJob').reembedActiveVintages).not.toHaveBeenCalled();
});

test.each([
  ['missing value', {}],
  ['string value', { value: 'true' }],
  ['number value', { value: 1 }],
])('%s → 400, nothing queried', async (_label, body) => {
  const res = await toggle(WINE_ID, body);
  expect(res.status).toBe(400);
  expect(WineDefinition.findById).not.toHaveBeenCalled();
});

test('invalid id → 400; unknown id → 404', async () => {
  expect((await toggle('nope', { value: true })).status).toBe(400);
  WineDefinition.findById.mockResolvedValue(null);
  expect((await toggle(WINE_ID, { value: true })).status).toBe(404);
});

test('the name-check scan pool excludes quarantined rows at the query level', async () => {
  const select = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
  WineDefinition.find.mockReturnValue({ select });

  await fetch(`${baseUrl}/api/admin/wines/producer-in-name`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });

  // pendingIdentity joins the exclusion: those rows have their own queue, and
  // flagging a row for the producer it does not have is noise, not a finding.
  expect(WineDefinition.find).toHaveBeenCalledWith({
    nonWine: { $ne: true }, pendingIdentity: { $ne: true },
  });
});

// #844 promised, in its commit message AND in the /:id/non-wine route comment,
// that flagged rows leave "the admin duplicate-scan pools" — but only the
// name-check pool above actually got the filter. A quarantined whisky stayed a
// merge candidate in all three of these (code audit 2026-07-27, H3). Asserted
// per pool so a future pool added without the filter fails here, not in prod.
describe('every duplicate/collision pool excludes quarantined rows', () => {
  const chainReturning = (rows) => {
    const lean = jest.fn().mockResolvedValue(rows);
    const chain = {
      select: jest.fn(() => chain),
      populate: jest.fn(() => chain),
      sort: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      lean,
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  };

  test.each([
    ['duplicate-clusters', '/api/admin/wines/duplicate-clusters'],
    ['canonical-collisions', '/api/admin/wines/canonical-collisions'],
  ])('%s filters nonWine', async (_label, path) => {
    WineDefinition.find.mockImplementation(() => chainReturning([]));

    await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${adminToken()}` },
    });

    expect(WineDefinition.find).toHaveBeenCalled();
    for (const call of WineDefinition.find.mock.calls) {
      expect(call[0]).toMatchObject({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } });
    }
  });
});
