/**
 * POST /api/admin/wines/:id/strip-producer and the label sweetness term
 * (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * Before renaming, the route refuses (409) when the same producer already has
 * a wine under the stripped name — the pair should be merged, not made to
 * collide. That twin check compared name and producer only: a termed wine and
 * its untermed twin (or two different terms) are two wines, and the rename of
 * one must not be refused on account of the other. The term is part of the
 * identity, so the check reads it and compares it, term-or-none by row. Mock
 * style follows wines.duplicateClusters.labelSweetness.test.js.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn(); ctor.findById = jest.fn(); ctor.findOne = jest.fn(); ctor.countDocuments = jest.fn();
  ctor.bulkWrite = jest.fn(); ctor.updateMany = jest.fn(); ctor.updateOne = jest.fn();
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
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexBottles: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const adminWinesRouter = require('./wines');

const adminToken = () => jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret');
const WID = '64b0000000000000000000b1';
const TWIN = '64b0000000000000000000b2';
const TROCKEN = '64b00000000000000000ee01';
const HALBTROCKEN = '64b00000000000000000ee02';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const post = async () => {
  const res = await fetch(`${baseUrl}/api/admin/wines/${WID}/strip-producer`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` } });
  return { status: res.status, body: await res.json() };
};

// The wine whose name carries its producer, as findById hands it to the route.
const wineDoc = (labelSweetness = null) => ({
  _id: WID, name: 'Keller Riesling Kabinett', producer: 'Keller', appellation: 'Rheinhessen', draft: false, labelSweetness,
  save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined),
});
let chain;
const twins = (rows) => {
  chain = { select: jest.fn(() => chain), limit: jest.fn(() => chain), lean: jest.fn(async () => rows) };
  WineDefinition.find.mockReturnValue(chain);
};
const twin = (labelSweetness) => ({ _id: TWIN, name: 'Riesling Kabinett', producer: 'Keller', ...(labelSweetness === undefined ? {} : { labelSweetness }) });

beforeEach(() => jest.clearAllMocks());

test('the twin check reads the term', async () => {
  WineDefinition.findById.mockResolvedValue(wineDoc());
  twins([]);
  expect((await post()).status).toBe(200);
  expect(chain.select.mock.calls[0][0].split(/\s+/)).toContain('labelSweetness');
});

test('the same producer with NO term on either side is the conflict it always was: 409, nothing renamed', async () => {
  const wine = wineDoc();
  WineDefinition.findById.mockResolvedValue(wine);
  twins([twin(null)]);
  const r = await post();
  expect(r.status).toBe(409);
  expect(r.body.conflictId).toBe(TWIN);
  expect(wine.save).not.toHaveBeenCalled();
});

test('a twin that predates the field (no key at all) counts as untermed — still the conflict', async () => {
  WineDefinition.findById.mockResolvedValue(wineDoc());
  twins([twin(undefined)]);
  expect((await post()).status).toBe(409);
});

test('a TERMED twin of an untermed wine is a different wine: the rename proceeds', async () => {
  const wine = wineDoc();
  WineDefinition.findById.mockResolvedValue(wine);
  twins([twin(TROCKEN)]);
  const r = await post();
  expect(r.status).toBe(200);
  expect(wine.name).toBe('Riesling Kabinett');
  expect(wine.save).toHaveBeenCalledTimes(1);
});

test('two DIFFERENT terms are two wines: the rename proceeds', async () => {
  WineDefinition.findById.mockResolvedValue(wineDoc(HALBTROCKEN));
  twins([twin(TROCKEN)]);
  expect((await post()).status).toBe(200);
});

test('the SAME term on both is the duplicate the merge tool is for: 409', async () => {
  const wine = wineDoc(TROCKEN);
  WineDefinition.findById.mockResolvedValue(wine);
  twins([twin(TROCKEN)]);
  expect((await post()).status).toBe(409);
  expect(wine.save).not.toHaveBeenCalled();
});
