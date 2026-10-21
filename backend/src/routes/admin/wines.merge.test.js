/**
 * The wine merge and delete machinery, pinned as it behaves today: which
 * references a merge re-points (with exactly which filter and update), how the
 * collections with a unique key reconcile, that a source wine is deleted only
 * after every reference has moved, and what the two merge routes and the
 * delete route answer. A merge runs without a transaction (standalone mongod),
 * so "delete the source last" is what makes a failed merge safe to re-run.
 *
 * Every model write is recorded in `calls` in the order it was made, so the
 * ordering is asserted, not assumed. utils/wineRefs lists every model that
 * references a wine; a test below checks that reassignWineRefs touches each
 * one it claims to handle.
 */

process.env.JWT_SECRET = 'test-secret';

function mockModel(...methods) {
  return Object.fromEntries(methods.map((m) => [m, jest.fn()]));
}

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  return Object.assign(ctor, mockModel('find', 'findById', 'findOne', 'countDocuments', 'findByIdAndUpdate', 'updateOne', 'updateMany', 'bulkWrite'));
});
jest.mock('../../models/Bottle', () => mockModel('distinct', 'updateMany', 'countDocuments', 'aggregate'));
jest.mock('../../models/DeletedBottle', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/BottleImage', () => mockModel('findOne', 'find', 'updateMany', 'findByIdAndUpdate', 'deleteMany'));
jest.mock('../../models/WineVintageProfile', () => mockModel('find', 'updateOne', 'deleteOne', 'deleteMany'));
jest.mock('../../models/WineVintagePrice', () => mockModel('updateMany', 'deleteMany'));
jest.mock('../../models/WineReport', () => mockModel('updateMany', 'deleteMany'));
jest.mock('../../models/Review', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/Discussion', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/DiscussionReply', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/WineEmbedding', () => mockModel('deleteMany'));
jest.mock('../../models/WineNotDuplicate', () => mockModel('deleteMany', 'find'));
jest.mock('../../models/WineList', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/WishlistItem', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/PriceTrackingRequest', () => mockModel('find', 'findOne', 'updateOne', 'deleteOne', 'deleteMany'));
jest.mock('../../models/PriceTrackingSkip', () => mockModel('find', 'updateOne', 'deleteOne', 'deleteMany'));
jest.mock('../../models/CommunityWinePrice', () => mockModel('deleteMany'));
jest.mock('../../models/JournalEntry', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/Recommendation', () => mockModel('updateMany', 'countDocuments'));
jest.mock('../../models/RestockAlert', () => mockModel('updateMany', 'deleteMany'));
jest.mock('../../models/WineRequest', () => mockModel('updateMany'));
jest.mock('../../models/PersonalDataEntry', () => mockModel('distinct', 'updateMany', 'countDocuments'));
jest.mock('../../models/RegistryDataValue', () => mockModel('find', 'updateMany', 'updateOne', 'deleteOne', 'deleteMany'));
jest.mock('../../models/Country', () => mockModel('findById'));
jest.mock('../../services/dataVersion', () => ({ bumpDataVersion: jest.fn() }));
jest.mock('../../services/wineCorrectionNotify', () => ({ closePendingForWine: jest.fn() }));
jest.mock('../../services/ownerInquiryOps', () => ({ repointInquiriesForWineMerge: jest.fn(), closeInquiriesForWineDelete: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn(), reembedActiveVintages: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const MODELS = {
  WineDefinition: require('../../models/WineDefinition'),
  Bottle: require('../../models/Bottle'),
  DeletedBottle: require('../../models/DeletedBottle'),
  BottleImage: require('../../models/BottleImage'),
  WineVintageProfile: require('../../models/WineVintageProfile'),
  WineVintagePrice: require('../../models/WineVintagePrice'),
  WineReport: require('../../models/WineReport'),
  Review: require('../../models/Review'),
  Discussion: require('../../models/Discussion'),
  DiscussionReply: require('../../models/DiscussionReply'),
  WineEmbedding: require('../../models/WineEmbedding'),
  WineNotDuplicate: require('../../models/WineNotDuplicate'),
  WineList: require('../../models/WineList'),
  WishlistItem: require('../../models/WishlistItem'),
  PriceTrackingRequest: require('../../models/PriceTrackingRequest'),
  PriceTrackingSkip: require('../../models/PriceTrackingSkip'),
  CommunityWinePrice: require('../../models/CommunityWinePrice'),
  JournalEntry: require('../../models/JournalEntry'),
  Recommendation: require('../../models/Recommendation'),
  RestockAlert: require('../../models/RestockAlert'),
  WineRequest: require('../../models/WineRequest'),
  PersonalDataEntry: require('../../models/PersonalDataEntry'),
  RegistryDataValue: require('../../models/RegistryDataValue'),
};
const {
  WineDefinition, Bottle, DeletedBottle, BottleImage, WineVintageProfile, WineVintagePrice, WineReport,
  Review, Discussion, DiscussionReply, WineEmbedding, WineNotDuplicate, WineList, WishlistItem,
  PriceTrackingRequest, PriceTrackingSkip, CommunityWinePrice, JournalEntry, Recommendation, RestockAlert, WineRequest,
  PersonalDataEntry, RegistryDataValue,
} = MODELS;
const { bumpDataVersion } = require('../../services/dataVersion');
const { closePendingForWine } = require('../../services/wineCorrectionNotify');
const { repointInquiriesForWineMerge, closeInquiriesForWineDelete } = require('../../services/ownerInquiryOps');
const { unlinkImageFiles } = require('../../services/imageProcessor');
const { embedSinglePair } = require('../../services/embeddingJob');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const SERVICES = { bumpDataVersion, closePendingForWine, repointInquiriesForWineMerge, closeInquiriesForWineDelete, unlinkImageFiles, embedSinglePair, removeWine: searchService.removeWine, indexWine: searchService.indexWine, logAudit };

const adminWinesRouter = require('./wines');
const { performWineMerge, reassignWineRefs } = adminWinesRouter;

const ADMIN_ID = '64b000000000000000000001';
const S = '64b0000000000000000000a1'; // source
const S2 = '64b0000000000000000000a2'; // second source (golden merge)
const K = '64b0000000000000000000b1'; // keeper / target
const REQ = { user: { id: ADMIN_ID } };

// ── Recording mocks ─────────────────────────────────────────────────────────

const calls = [];
const NAMES = new Map();
const rec = (name, impl) => (...args) => { calls.push(name); return impl(...args); };
const stub = (fn, impl) => fn.mockImplementation(rec(NAMES.get(fn), impl));

/** A query result that can be awaited directly or through .select()/.lean(). */
const chain = (result) => {
  const c = {
    select: () => c,
    lean: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return c;
};

const DEFAULTS = {
  updateMany: async () => ({ modifiedCount: 0 }),
  deleteMany: async () => ({ deletedCount: 0 }),
  updateOne: async () => ({ modifiedCount: 1 }),
  deleteOne: async () => ({ deletedCount: 1 }),
  countDocuments: async () => 0,
  distinct: async () => [],
  findByIdAndUpdate: async () => null,
  find: () => chain([]),
  findOne: () => chain(null),
  findById: async () => null,
  aggregate: async () => [],
};

let docs;
const wine = (id, extra = {}) => ({
  _id: id,
  name: 'Grand Vin',
  producer: 'Ch. Keeper',
  image: null,
  imageCredit: null,
  aiProfile: null,
  ...extra,
  deleteOne: jest.fn(async () => { calls.push(`deleteOne:${id}`); }),
  save: jest.fn(async () => { calls.push(`save:${id}`); }),
});

beforeEach(() => {
  calls.length = 0;
  NAMES.clear();
  for (const [name, mod] of Object.entries(MODELS)) {
    for (const [m, fn] of Object.entries(mod)) {
      if (!jest.isMockFunction(fn)) continue;
      fn.mockReset();
      NAMES.set(fn, `${name}.${m}`);
      fn.mockImplementation(rec(`${name}.${m}`, DEFAULTS[m] || (async () => undefined)));
    }
  }
  for (const [name, fn] of Object.entries(SERVICES)) {
    fn.mockReset();
    NAMES.set(fn, name);
    fn.mockImplementation(rec(name, async () => undefined));
  }
  docs = {};
  stub(WineDefinition.findById, async (id) => docs[String(id)] ?? null);
  stub(WineDefinition.find, async (q) => (q._id.$in || []).map(String).map((id) => docs[id]).filter(Boolean));
});

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
// Ids may be strings or ObjectIds depending on the caller: compare through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Every write reassignWineRefs makes (deletes of the source's derived rows included).
const REASSIGN_WRITES = [
  'Bottle.updateMany', 'DeletedBottle.updateMany', 'BottleImage.updateMany', 'WineVintagePrice.updateMany',
  'WineReport.updateMany', 'Discussion.updateMany', 'DiscussionReply.updateMany', 'WineEmbedding.deleteMany',
  'WineNotDuplicate.deleteMany', 'Review.updateMany', 'WishlistItem.updateMany', 'CommunityWinePrice.deleteMany',
  'JournalEntry.updateMany', 'Recommendation.updateMany', 'RestockAlert.updateMany', 'WineRequest.updateMany',
  'WineList.updateMany',
];

// ── HTTP harness ────────────────────────────────────────────────────────────

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const send = async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api/admin/wines${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret')}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// ── reassignWineRefs ────────────────────────────────────────────────────────

describe('reassignWineRefs', () => {
  test('moves the bottles first, bumps each owner once, and returns the number moved', async () => {
    stub(Bottle.distinct, async (field) => (field === 'user' ? ['u1', 'u2'] : []));
    stub(Bottle.updateMany, async () => ({ modifiedCount: 3 }));

    expect(await reassignWineRefs(S, K)).toBe(3);

    expect(Bottle.distinct).toHaveBeenCalledWith('user', { wineDefinition: S });
    expect(Bottle.updateMany).toHaveBeenCalledWith({ wineDefinition: S }, { $set: { wineDefinition: K } });
    expect(bumpDataVersion.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2']);
    expect(calls.indexOf('Bottle.updateMany')).toBeLessThan(calls.indexOf('bumpDataVersion'));
  });

  test('re-points every other reference with its exact filter and update', async () => {
    await reassignWineRefs(S, K);
    const moveTo = { $set: { wineDefinition: K } };

    for (const Model of [DeletedBottle, BottleImage, WineVintagePrice, Discussion, DiscussionReply, Review, WishlistItem]) {
      expect(Model.updateMany).toHaveBeenCalledWith({ wineDefinition: S }, moveTo);
    }
    expect(WineReport.updateMany).toHaveBeenCalledWith({ wineDefinition: S }, moveTo);
    expect(WineReport.updateMany).toHaveBeenCalledWith({ duplicateOf: S }, { $set: { duplicateOf: K } });
    expect(Recommendation.updateMany).toHaveBeenCalledWith({ wine: S }, { $set: { wine: K } });
    expect(RestockAlert.updateMany).toHaveBeenCalledWith({ wine: S }, { $set: { wine: K } });
    expect(WineRequest.updateMany).toHaveBeenCalledWith({ linkedWineDefinition: S }, { $set: { linkedWineDefinition: K } });
    expect(JournalEntry.updateMany).toHaveBeenCalledWith(
      { 'pairings.wine': S }, { $set: { 'pairings.$[e].wine': K } }, { arrayFilters: [{ 'e.wine': S }] });
    expect(WineList.updateMany).toHaveBeenCalledWith(
      { 'autoGroupEntries.wine': S }, { $set: { 'autoGroupEntries.$[e].wine': K } }, { arrayFilters: [{ 'e.wine': S }] });
    expect(WineList.updateMany).toHaveBeenCalledWith(
      { 'sections.entries.wine': S }, { $set: { 'sections.$[].entries.$[e].wine': K } }, { arrayFilters: [{ 'e.wine': S }] });

    // The keeper joins similarWineIds before the source leaves, so it is never duplicated.
    const similar = RestockAlert.updateMany.mock.calls.filter(([filter]) => 'similarWineIds' in filter);
    expect(similar).toEqual([
      [{ similarWineIds: S }, { $addToSet: { similarWineIds: K } }],
      [{ similarWineIds: S }, { $pull: { similarWineIds: S } }],
    ]);

    // The source's derived rows are dropped, not moved.
    expect(WineEmbedding.deleteMany).toHaveBeenCalledWith({ wineDefinition: S });
    expect(WineNotDuplicate.deleteMany).toHaveBeenCalledWith({ $or: [{ wineA: S }, { wineB: S }] });
    expect(CommunityWinePrice.deleteMany).toHaveBeenCalledWith({ wineDefinition: S });
  });

  test('never deletes a wine, and a second run makes the same writes and moves nothing', async () => {
    let moved = 2;
    stub(Bottle.updateMany, async () => { const n = moved; moved = 0; return { modifiedCount: n }; });

    expect(await reassignWineRefs(S, K)).toBe(2);
    const first = [...calls].sort();
    calls.length = 0;
    expect(await reassignWineRefs(S, K)).toBe(0);

    expect([...calls].sort()).toEqual(first);
    expect(first.some((c) => c.startsWith('deleteOne:') || c.startsWith('WineDefinition.'))).toBe(false);
  });

  test('maturity profiles reconcile per vintage against the keeper', async () => {
    const sourceRows = [
      { _id: 'p2019', vintage: '2019', status: 'pending' }, // keeper has none: moved
      { _id: 'p2018', vintage: '2018', status: 'reviewed' }, // keeper only pending: keeper's dropped, source's moved
      { _id: 'p2017', vintage: '2017', status: 'pending' }, // keeper reviewed: source's dropped
      { _id: 'p2016', vintage: '2016', status: 'pending' }, // both pending: source's dropped
    ];
    const keeperRows = [
      { vintage: '2018', status: 'pending' },
      { vintage: '2017', status: 'reviewed' },
      { vintage: '2016', status: 'pending' },
    ];
    stub(WineVintageProfile.find, (filter) => chain(String(filter.wineDefinition) === S ? sourceRows : keeperRows));

    await reassignWineRefs(S, K);

    const moved = { $set: { wineDefinition: K, updatedAt: expect.any(Date) } };
    expect(WineVintageProfile.updateOne.mock.calls).toEqual([
      [{ _id: 'p2019' }, moved],
      [{ _id: 'p2018' }, moved],
    ]);
    expect(WineVintageProfile.deleteOne.mock.calls).toEqual([
      [{ wineDefinition: K, vintage: '2018' }],
      [{ _id: 'p2017' }],
      [{ _id: 'p2016' }],
    ]);
    const order = calls.filter((c) => c.startsWith('WineVintageProfile.') && !c.endsWith('.find'));
    expect(order.slice(1, 3)).toEqual(['WineVintageProfile.deleteOne', 'WineVintageProfile.updateOne']);
  });

  test('price-tracking requests: moved when free, folded into the keeper on a vintage collision', async () => {
    const sourceRequests = [
      { _id: 'r2019', vintage: '2019', requesters: [{ user: 'u1' }] },
      {
        _id: 'r2018', vintage: '2018', requesters: [{ user: 'u1' }, { user: 'u3' }],
        firstRequestedAt: new Date('2026-01-01'), lastRequestedAt: new Date('2026-09-01'),
      },
    ];
    const keeperRequest = {
      vintage: '2018', requesters: [{ user: 'u1' }],
      firstRequestedAt: new Date('2026-03-01'), lastRequestedAt: new Date('2026-05-01'),
      save: jest.fn(async () => { calls.push('keeperRequest.save'); }),
    };
    stub(PriceTrackingRequest.find, (filter) => chain(String(filter.wineDefinition) === S ? sourceRequests : [{ vintage: '2018' }]));
    stub(PriceTrackingRequest.findOne, async () => keeperRequest);
    stub(PriceTrackingSkip.find, (filter) => chain(String(filter.wineDefinition) === S ? [{ _id: 's2019', vintage: '2019' }] : [{ vintage: '2019' }]));

    await reassignWineRefs(S, K);

    expect(PriceTrackingRequest.updateOne).toHaveBeenCalledWith({ _id: 'r2019' }, { $set: { wineDefinition: K } });
    expect(PriceTrackingRequest.findOne).toHaveBeenCalledWith({ wineDefinition: K, vintage: '2018' });
    expect(keeperRequest.requesters.map((r) => r.user)).toEqual(['u1', 'u3']);
    expect(keeperRequest.firstRequestedAt).toEqual(new Date('2026-01-01'));
    expect(keeperRequest.lastRequestedAt).toEqual(new Date('2026-09-01'));
    expect(keeperRequest.save).toHaveBeenCalled();
    expect(PriceTrackingRequest.deleteOne).toHaveBeenCalledWith({ _id: 'r2018' });
    expect(calls.indexOf('keeperRequest.save')).toBeLessThan(calls.indexOf('PriceTrackingRequest.deleteOne'));

    // A skip collision keeps the keeper's skip and drops the source's.
    expect(PriceTrackingSkip.updateOne).not.toHaveBeenCalled();
    expect(PriceTrackingSkip.deleteOne).toHaveBeenCalledWith({ _id: 's2019' });
  });
});

// ── performWineMerge ────────────────────────────────────────────────────────

describe('performWineMerge', () => {
  const setUpPair = (sourceExtra = {}, targetExtra = {}) => {
    docs[S] = wine(S, { producer: 'Ch. Source', aiProfile: { description: 'Dark fruit.', confidence: 0.8 }, ...sourceExtra });
    docs[K] = wine(K, { image: 'keeper.webp', ...targetExtra });
    stub(Bottle.distinct, async (field) => (field === 'user' ? ['u1'] : ['2019', '2020']));
    stub(Bottle.updateMany, async () => ({ modifiedCount: 3 }));
  };

  test('deletes the source only after every reference moved, the profile was inherited and the merge was audited', async () => {
    setUpPair();

    const result = await performWineMerge(S, K, REQ);
    await flush();

    expect(result).toMatchObject({ bottlesMoved: 3, imageAction: 'none', source: docs[S], target: docs[K] });
    const deleted = calls.indexOf(`deleteOne:${S}`);
    expect(deleted).toBeGreaterThan(-1);
    for (const write of REASSIGN_WRITES) expect(calls.lastIndexOf(write)).toBeLessThan(deleted);
    expect(calls.indexOf('WineDefinition.updateOne')).toBeLessThan(deleted); // inheritAiProfile
    expect(calls.indexOf('logAudit')).toBeLessThan(deleted);
    expect(logAudit).toHaveBeenCalledWith(REQ, 'admin.wine.merge', { type: 'wine', id: S }, expect.objectContaining({
      sourceProducer: 'Ch. Source', targetId: K, targetProducer: 'Ch. Keeper', bottlesMoved: 3, imageAction: 'none',
    }));

    // After the delete: search, then the pending proposals, then the owner inquiries.
    expect(searchService.removeWine).toHaveBeenCalledWith(S);
    expect(calls.indexOf('removeWine')).toBeGreaterThan(deleted);
    expect(closePendingForWine).toHaveBeenCalledWith(
      S,
      expect.stringContaining('merged into "Ch. Keeper — Grand Vin"'),
      { wine: docs[S], linkWineId: K, actorId: ADMIN_ID });
    expect(calls.indexOf('closePendingForWine')).toBeGreaterThan(deleted);
    expect(repointInquiriesForWineMerge).toHaveBeenCalledWith(S, K, 'Ch. Keeper — Grand Vin', REQ);
    expect(calls.indexOf('repointInquiriesForWineMerge')).toBeGreaterThan(calls.indexOf('closePendingForWine'));

    // Then every active vintage of the keeper is re-embedded.
    expect(Bottle.distinct).toHaveBeenCalledWith('vintage', { wineDefinition: K, status: 'active' });
    expect(embedSinglePair.mock.calls).toEqual([[K, '2019'], [K, '2020']]);
  });

  test("the keeper adopts the source's primary image when it has none", async () => {
    setUpPair({ imageCredit: 'Photo: Source' }, { image: null });
    stub(BottleImage.findOne, () => chain({ _id: 'img1', processedUrl: 'p.webp', originalUrl: 'o.jpg' }));

    const result = await performWineMerge(S, K, REQ);

    expect(BottleImage.findOne).toHaveBeenCalledWith({ wineDefinition: S, assignedToWine: true });
    expect(calls.indexOf('BottleImage.findOne')).toBeLessThan(calls.indexOf('Bottle.updateMany'));
    expect(result.imageAction).toBe('adopted_from_source');
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(K, { image: 'p.webp', imageCredit: 'Photo: Source' });
    expect(searchService.indexWine).toHaveBeenCalledWith(K);
  });

  test("a keeper with its own image keeps it; the source's image stops being a primary", async () => {
    setUpPair();
    stub(BottleImage.findOne, () => chain({ _id: 'img1', processedUrl: 'p.webp', originalUrl: 'o.jpg' }));

    const result = await performWineMerge(S, K, REQ);

    expect(result.imageAction).toBe('cleared_source_assignment');
    expect(BottleImage.findByIdAndUpdate).toHaveBeenCalledWith('img1', { assignedToWine: false });
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test.each([
    ['the source is missing', () => { docs[K] = wine(K); }, 'Source wine not found'],
    ['the source is a private draft', () => { docs[S] = wine(S, { draft: true }); docs[K] = wine(K); }, 'Source wine not found'],
    ['the target is missing', () => { docs[S] = wine(S); }, 'Target wine not found'],
    ['the target is a private draft', () => { docs[S] = wine(S); docs[K] = wine(K, { draft: true }); }, 'Target wine not found'],
  ])('refuses with 404 and writes nothing when %s', async (_label, setUp, message) => {
    setUp();
    expect(await performWineMerge(S, K, REQ)).toEqual({ error: { status: 404, message } });
    expect(calls.filter((c) => c !== 'WineDefinition.findById')).toEqual([]);
  });
});

// ── POST /:id/merge ─────────────────────────────────────────────────────────

describe('POST /api/admin/wines/:id/merge', () => {
  test.each([
    ['a non-id source', '/not-an-id/merge', { targetId: K }, 'Invalid ID'],
    ['no targetId', `/${S}/merge`, {}, 'A valid targetId is required'],
    ['a malformed targetId', `/${S}/merge`, { targetId: 'nope' }, 'A valid targetId is required'],
    ['the same id twice', `/${S}/merge`, { targetId: S }, 'Cannot merge a wine into itself'],
  ])('400 for %s, with no lookup', async (_label, path, body, error) => {
    const res = await send('POST', path, body);
    expect(res).toEqual({ status: 400, body: { error } });
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });

  test('200 with the bottles moved and the image action', async () => {
    docs[S] = wine(S);
    docs[K] = wine(K, { image: 'keeper.webp' });
    stub(Bottle.updateMany, async () => ({ modifiedCount: 4 }));

    const res = await send('POST', `/${S}/merge`, { targetId: K });

    expect(res).toEqual({ status: 200, body: { message: 'Wines merged successfully', bottlesMoved: 4, imageAction: 'none' } });
    expect(docs[S].deleteOne).toHaveBeenCalled();
  });

  test("passes performWineMerge's 404 through", async () => {
    docs[K] = wine(K);
    expect(await send('POST', `/${S}/merge`, { targetId: K })).toEqual({ status: 404, body: { error: 'Source wine not found' } });
  });

  test('500 when a re-point fails, and the source is NOT deleted (the merge can be re-run)', async () => {
    docs[S] = wine(S);
    docs[K] = wine(K);
    stub(Review.updateMany, async () => { throw new Error('write failed'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send('POST', `/${S}/merge`, { targetId: K });

    expect(res).toEqual({ status: 500, body: { error: 'Failed to merge wines' } });
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
    console.error.mockRestore();
  });
});

// ── POST /merge (golden record) ─────────────────────────────────────────────

describe('POST /api/admin/wines/merge', () => {
  test.each([
    ['an invalid keeperId', { keeperId: 'nope', sourceIds: [S] }, 'A valid keeperId is required'],
    ['no sourceIds', { keeperId: K }, 'sourceIds must be a non-empty array'],
    ['an empty sourceIds', { keeperId: K, sourceIds: [] }, 'sourceIds must be a non-empty array'],
    ['sources that are all the keeper or invalid', { keeperId: K, sourceIds: [K, 'nope'] }, 'No valid source ids (distinct from the keeper) provided'],
    ['an invalid imageFromWineId', { keeperId: K, sourceIds: [S], imageFromWineId: 'nope' }, 'Invalid imageFromWineId'],
  ])('400 for %s', async (_label, body, error) => {
    expect(await send('POST', '/merge', body)).toEqual({ status: 400, body: { error } });
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });

  test('404 when the keeper is missing, and when no source exists', async () => {
    expect(await send('POST', '/merge', { keeperId: K, sourceIds: [S] })).toEqual({ status: 404, body: { error: 'Keeper wine not found' } });
    docs[K] = wine(K);
    expect(await send('POST', '/merge', { keeperId: K, sourceIds: [S] })).toEqual({ status: 404, body: { error: 'No source wines found' } });
    expect(calls.some((c) => c.startsWith('deleteOne:'))).toBe(false);
  });

  test('re-points each source, closes and re-points its follow-ups, then audits and deletes each source last', async () => {
    docs[K] = wine(K, { image: 'keeper.webp' });
    docs[S] = wine(S, { producer: 'Ch. Source' });
    docs[S2] = wine(S2, { producer: 'Ch. Source Two' });
    stub(Bottle.updateMany, async (filter) => ({ modifiedCount: String(filter.wineDefinition) === S ? 2 : 3 }));

    const res = await send('POST', '/merge', { keeperId: K, sourceIds: [S, S2, S] });
    await flush();

    expect(res).toEqual({ status: 200, body: { message: 'Wines merged successfully', sourcesMerged: 2, bottlesMoved: 5, imageAction: 'kept' } });
    expect(plain(Bottle.updateMany.mock.calls)).toEqual([
      [{ wineDefinition: S }, { $set: { wineDefinition: K } }],
      [{ wineDefinition: S2 }, { $set: { wineDefinition: K } }],
    ]);
    const label = 'Ch. Keeper — Grand Vin';
    expect(plain(closePendingForWine.mock.calls.map((c) => [c[0], c[2].linkWineId]))).toEqual([[S, K], [S2, K]]);
    for (const c of closePendingForWine.mock.calls) expect(c[1]).toContain(`merged into "${label}"`);
    expect(plain(repointInquiriesForWineMerge.mock.calls.map((c) => [c[0], c[1], c[2]]))).toEqual([[S, K, label], [S2, K, label]]);

    const firstDelete = Math.min(calls.indexOf(`deleteOne:${S}`), calls.indexOf(`deleteOne:${S2}`));
    for (const write of [...REASSIGN_WRITES, 'closePendingForWine', 'repointInquiriesForWineMerge']) {
      expect(calls.lastIndexOf(write)).toBeLessThan(firstDelete);
    }
    expect(logAudit.mock.calls.map((c) => [c[1], c[2].id, c[3].golden, c[3].bottlesMoved])).toEqual([
      ['admin.wine.merge', S, true, 5],
      ['admin.wine.merge', S2, true, 5],
    ]);
    // Per source: audit, then delete, then out of the search index.
    expect(calls.filter((c) => ['logAudit', `deleteOne:${S}`, `deleteOne:${S2}`, 'removeWine'].includes(c))).toEqual([
      'logAudit', `deleteOne:${S}`, 'removeWine', 'logAudit', `deleteOne:${S2}`, 'removeWine',
    ]);
    expect(searchService.indexWine).toHaveBeenCalledWith(K);
  });

  test('imageFromWineId makes that photo the only primary and the keeper image', async () => {
    docs[K] = wine(K, { image: 'keeper.webp' });
    docs[S] = wine(S);
    stub(BottleImage.findOne, () => chain({ _id: 'img9', processedUrl: 'chosen.webp', originalUrl: 'chosen.jpg', credit: 'Photo: Source' }));

    const res = await send('POST', '/merge', { keeperId: K, sourceIds: [S], imageFromWineId: S });

    expect(res.body.imageAction).toBe('set_chosen');
    expect(plain(BottleImage.findOne.mock.calls[0])).toEqual([{ wineDefinition: S, assignedToWine: true }]);
    expect(calls.indexOf('BottleImage.findOne')).toBeLessThan(calls.indexOf('Bottle.updateMany'));
    expect(plain(BottleImage.updateMany.mock.calls.at(-1))).toEqual([
      { wineDefinition: K, _id: { $ne: 'img9' }, assignedToWine: true }, { $set: { assignedToWine: false } },
    ]);
    expect(BottleImage.findByIdAndUpdate).toHaveBeenCalledWith('img9', { assignedToWine: true });
    expect(docs[K]).toMatchObject({ image: 'chosen.webp', imageCredit: 'Photo: Source' });
    expect(docs[K].save).toHaveBeenCalled();
  });

  test('without a choice, a keeper with no image adopts any primary now on it', async () => {
    docs[K] = wine(K, { image: null });
    docs[S] = wine(S);
    stub(BottleImage.findOne, () => chain({ processedUrl: null, originalUrl: 'any.jpg', credit: null }));

    const res = await send('POST', '/merge', { keeperId: K, sourceIds: [S] });

    expect(res.body.imageAction).toBe('adopted');
    expect(docs[K]).toMatchObject({ image: 'any.jpg', imageCredit: null });
    expect(docs[K].save).toHaveBeenCalled();
  });
});

// ── DELETE /:id ─────────────────────────────────────────────────────────────

describe('DELETE /api/admin/wines/:id', () => {
  test('404 for a private draft', async () => {
    docs[S] = wine(S, { draft: true });
    expect(await send('DELETE', `/${S}`)).toEqual({ status: 404, body: { error: 'Wine not found' } });
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
  });

  test('400 naming every kind of user content that still references the wine, and nothing is deleted', async () => {
    docs[S] = wine(S);
    stub(Bottle.countDocuments, async () => 2);
    stub(Review.countDocuments, async () => 1);
    stub(WineList.countDocuments, async () => 1);

    const res = await send('DELETE', `/${S}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Cannot delete wine. User content references it (2 bottles, 1 reviews, 1 wineLists). Merge it into another wine instead.',
      references: {
        bottles: 2, recentlyDeletedBottles: 0, wishlistItems: 0, reviews: 1, discussions: 0,
        discussionReplies: 0, journalEntries: 0, wineLists: 1, recommendations: 0, personalDataEntries: 0,
      },
      bottleCount: 2,
    });
    expect(plain(WineList.countDocuments.mock.calls[0])).toEqual([{ $or: [{ 'sections.entries.wine': S }, { 'autoGroupEntries.wine': S }] }]);
    expect(calls.some((c) => /deleteMany|updateMany|deleteOne/.test(c))).toBe(false);
  });

  test('with no user content: cascades the derived data, unlinks orphan images, audits, then deletes the wine', async () => {
    docs[S] = wine(S, { name: 'Lonely Wine', producer: 'Nobody' });
    const orphan = { originalUrl: 'o1.jpg', processedUrl: 'p1.webp' };
    stub(BottleImage.find, () => chain([orphan]));

    const res = await send('DELETE', `/${S}`);

    expect(res).toEqual({ status: 200, body: { message: 'Wine deleted successfully' } });
    const byWine = { wineDefinition: S };
    for (const Model of [WineVintageProfile, WineVintagePrice, PriceTrackingRequest, PriceTrackingSkip, CommunityWinePrice, WineReport, WineEmbedding]) {
      expect(Model.deleteMany).toHaveBeenCalledWith(byWine);
    }
    expect(RestockAlert.deleteMany).toHaveBeenCalledWith({ wine: S });
    expect(RestockAlert.updateMany).toHaveBeenCalledWith({ similarWineIds: S }, { $pull: { similarWineIds: S } });
    expect(WineReport.updateMany).toHaveBeenCalledWith({ duplicateOf: S }, { $unset: { duplicateOf: '' } });
    expect(WineRequest.updateMany).toHaveBeenCalledWith({ linkedWineDefinition: S }, { $unset: { linkedWineDefinition: '' } });
    expect(WineNotDuplicate.deleteMany).toHaveBeenCalledWith({ $or: [{ wineA: S }, { wineB: S }] });
    expect(closePendingForWine).toHaveBeenCalledWith(S, 'Closed automatically: the wine was deleted before review.', { wine: docs[S], actorId: ADMIN_ID });
    expect(closeInquiriesForWineDelete).toHaveBeenCalledWith(S, expect.anything());

    // Orphan photos: files first (the doc holds the only reference), then the docs.
    expect(BottleImage.find).toHaveBeenCalledWith({ wineDefinition: S, bottle: null });
    expect(unlinkImageFiles).toHaveBeenCalledWith(orphan);
    expect(calls.indexOf('unlinkImageFiles')).toBeLessThan(calls.indexOf('BottleImage.deleteMany'));
    expect(BottleImage.deleteMany).toHaveBeenCalledWith({ wineDefinition: S, bottle: null });
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ wineDefinition: S }, { $unset: { wineDefinition: '' }, $set: { assignedToWine: false } });

    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.wine.delete', { type: 'wine', id: S },
      { name: 'Lonely Wine', producer: 'Nobody', imagesDeleted: 1 });
    const deleted = calls.indexOf(`deleteOne:${S}`);
    for (const c of calls.slice(deleted + 1)) expect(c).toBe('removeWine');
    expect(calls.indexOf('logAudit')).toBeLessThan(deleted);
    expect(searchService.removeWine).toHaveBeenCalledWith(S);
  });
});

// ── Self-merge and private drafts ───────────────────────────────────────────

describe('a wine never merges into itself, and a private draft never takes part', () => {
  const S_UPPER = S.toUpperCase();
  const K_UPPER = K.toUpperCase();

  // MongoDB casts an id in either letter case to the same ObjectId; the
  // stubs do the same, and honour the draft filter a query carries.
  beforeEach(() => {
    stub(WineDefinition.findById, async (id) => docs[String(id).toLowerCase()] ?? null);
    stub(WineDefinition.find, async (q) => (q._id.$in || [])
      .map((id) => docs[String(id).toLowerCase()])
      .filter((d) => d && !(q.draft?.$ne === true && d.draft === true)));
  });

  test.each([
    ['the same id', S],
    ['the same id in another letter case', S_UPPER],
  ])('performWineMerge refuses %s on both sides and writes nothing', async (_label, target) => {
    docs[S] = wine(S);
    expect(await performWineMerge(S, target, REQ)).toEqual({ error: { status: 400, message: 'Cannot merge a wine into itself' } });
    expect(calls.filter((c) => c !== 'WineDefinition.findById')).toEqual([]);
  });

  test('POST /:id/merge refuses the same id in another letter case before any lookup', async () => {
    docs[S] = wine(S);
    expect(await send('POST', `/${S}/merge`, { targetId: S_UPPER })).toEqual({ status: 400, body: { error: 'Cannot merge a wine into itself' } });
    expect(WineDefinition.findById).not.toHaveBeenCalled();
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
  });

  test.each([
    ['a number', 123],
    ['a 12-character string', 'abcdefghijkl'],
  ])('POST /:id/merge answers 400 for %s as targetId', async (_label, targetId) => {
    expect(await send('POST', `/${S}/merge`, { targetId })).toEqual({ status: 400, body: { error: 'A valid targetId is required' } });
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });

  test('POST /merge drops the keeper from the sources whatever its letter case', async () => {
    docs[K] = wine(K, { image: 'keeper.webp' });
    docs[S] = wine(S);

    expect(await send('POST', '/merge', { keeperId: K, sourceIds: [K_UPPER] }))
      .toEqual({ status: 400, body: { error: 'No valid source ids (distinct from the keeper) provided' } });

    const res = await send('POST', '/merge', { keeperId: K, sourceIds: [K_UPPER, S, S_UPPER] });
    expect(res.status).toBe(200);
    expect(res.body.sourcesMerged).toBe(1);
    expect(plain(WineDefinition.find.mock.calls.at(-1)[0]._id)).toEqual({ $in: [S] });
    expect(docs[K].deleteOne).not.toHaveBeenCalled();
    expect(docs[S].deleteOne).toHaveBeenCalledTimes(1);
  });

  test('POST /merge answers 404 for a draft keeper and moves nothing', async () => {
    docs[K] = wine(K, { draft: true });
    docs[S] = wine(S);
    expect(await send('POST', '/merge', { keeperId: K, sourceIds: [S] })).toEqual({ status: 404, body: { error: 'Keeper wine not found' } });
    expect(Bottle.updateMany).not.toHaveBeenCalled();
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
  });

  test('POST /merge leaves a draft source out and merges the rest', async () => {
    docs[K] = wine(K, { image: 'keeper.webp' });
    docs[S] = wine(S, { draft: true });
    docs[S2] = wine(S2);

    const res = await send('POST', '/merge', { keeperId: K, sourceIds: [S, S2] });

    expect(res.status).toBe(200);
    expect(res.body.sourcesMerged).toBe(1);
    expect(WineDefinition.find.mock.calls.at(-1)[0]).toMatchObject({ draft: { $ne: true } });
    expect(plain(Bottle.updateMany.mock.calls.map((c) => c[0]))).toEqual([{ wineDefinition: S2 }]);
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
    expect(docs[S2].deleteOne).toHaveBeenCalledTimes(1);
  });

  test('POST /merge with only draft sources answers 404 and moves nothing', async () => {
    docs[K] = wine(K);
    docs[S] = wine(S, { draft: true });
    expect(await send('POST', '/merge', { keeperId: K, sourceIds: [S] })).toEqual({ status: 404, body: { error: 'No source wines found' } });
    expect(Bottle.updateMany).not.toHaveBeenCalled();
  });
});

// ── Personal data entries and registry values ───────────────────────────────

describe('members\' personal entries and the registry values follow a merge; a delete keeps them safe', () => {
  test('wine-level personal entries move to the keeper, and their authors\' data version moves too', async () => {
    stub(Bottle.distinct, async (field) => (field === 'user' ? ['owner1'] : []));
    stub(PersonalDataEntry.distinct, async () => ['author1', 'author2']);

    await reassignWineRefs(S, K);

    expect(PersonalDataEntry.distinct).toHaveBeenCalledWith('author', { wineDefinition: S });
    expect(PersonalDataEntry.updateMany).toHaveBeenCalledWith({ wineDefinition: S }, { $set: { wineDefinition: K } });
    expect(bumpDataVersion.mock.calls.map((c) => c[0]).sort()).toEqual(['author1', 'author2', 'owner1']);
  });

  test('registry values: rejected rows move; a suggested or published row moves unless the keeper holds that slot', async () => {
    const sourceRows = [
      { _id: 'v1', key: 'abv', vintage: null, status: 'published' }, // keeper's abv/default is only rejected: moves
      { _id: 'v2', key: 'closure', status: 'published' }, // no vintage field = the default slot; keeper holds it: dropped
      { _id: 'v3', key: 'abv', vintage: '2019', status: 'suggested' }, // free slot: moves
    ];
    const keeperRows = [
      { key: 'closure', vintage: null, status: 'published' },
      { key: 'abv', vintage: null, status: 'rejected' },
    ];
    stub(RegistryDataValue.find, (filter) => chain(String(filter.wineDefinition) === S ? sourceRows : keeperRows));

    await reassignWineRefs(S, K);

    expect(RegistryDataValue.updateMany).toHaveBeenCalledWith({ wineDefinition: S, status: 'rejected' }, { $set: { wineDefinition: K } });
    expect(calls.indexOf('RegistryDataValue.updateMany')).toBeLessThan(calls.indexOf('RegistryDataValue.find'));
    expect(RegistryDataValue.updateOne.mock.calls).toEqual([
      [{ _id: 'v1' }, { $set: { wineDefinition: K } }],
      [{ _id: 'v3' }, { $set: { wineDefinition: K } }],
    ]);
    expect(RegistryDataValue.deleteOne.mock.calls).toEqual([[{ _id: 'v2' }]]);
  });

  test('a merge moves both before it deletes the source', async () => {
    docs[S] = wine(S);
    docs[K] = wine(K, { image: 'keeper.webp' });

    await performWineMerge(S, K, REQ);

    const deleted = calls.indexOf(`deleteOne:${S}`);
    expect(deleted).toBeGreaterThan(-1);
    for (const write of ['PersonalDataEntry.updateMany', 'RegistryDataValue.updateMany']) {
      expect(calls).toContain(write);
      expect(calls.lastIndexOf(write)).toBeLessThan(deleted);
    }
  });

  test('reassignWineRefs touches every model utils/wineRefs says it handles', async () => {
    const { WINE_REF_HANDLED } = require('../../utils/wineRefs');
    await reassignWineRefs(S, K);
    const touched = new Set(calls.map((c) => c.split('.')[0]));
    expect(WINE_REF_HANDLED.filter((name) => !touched.has(name))).toEqual([]);
    expect(WINE_REF_HANDLED.filter((name) => !MODELS[name])).toEqual([]);
  });

  test('DELETE refuses a wine that members still hold personal entries on, and deletes nothing', async () => {
    docs[S] = wine(S);
    stub(PersonalDataEntry.countDocuments, async () => 2);

    const res = await send('DELETE', `/${S}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot delete wine. User content references it (2 personalDataEntries). Merge it into another wine instead.');
    expect(res.body.references.personalDataEntries).toBe(2);
    expect(PersonalDataEntry.countDocuments).toHaveBeenCalledWith({ wineDefinition: S });
    expect(RegistryDataValue.deleteMany).not.toHaveBeenCalled();
    expect(docs[S].deleteOne).not.toHaveBeenCalled();
  });

  test('DELETE of a wine with no user content removes its registry values with it', async () => {
    docs[S] = wine(S);

    expect(await send('DELETE', `/${S}`)).toEqual({ status: 200, body: { message: 'Wine deleted successfully' } });

    expect(RegistryDataValue.deleteMany).toHaveBeenCalledWith({ wineDefinition: S });
    expect(calls.indexOf('RegistryDataValue.deleteMany')).toBeLessThan(calls.indexOf(`deleteOne:${S}`));
  });
});
