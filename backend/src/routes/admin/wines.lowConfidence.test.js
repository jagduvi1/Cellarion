/**
 * GET /api/admin/wines/low-confidence + the profile-reviewed toggle — the
 * "model in doubt" queue. Pins: the outstanding filter's self-invalidating
 * comparison (reviewedAt vs generatedAt — NOT a boolean), threshold clamping
 * against junk input, and the audited mark/unmark round-trip.
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
  ctor.updateOne = jest.fn();
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
jest.mock('../../services/enrichmentJob', () => ({ releaseHeldProfile: jest.fn().mockResolvedValue(true) }));
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
const Bottle = require('../../models/Bottle');
const { logAudit } = require('../../services/audit');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000d1';
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

const listChain = (rows) => {
  const chain = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.populate = jest.fn().mockReturnValue(chain);
  chain.sort = jest.fn().mockReturnValue(chain);
  chain.skip = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.lean = jest.fn().mockResolvedValue(rows);
  return chain;
};

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(listChain([]));
  WineDefinition.countDocuments.mockResolvedValue(0);
  WineDefinition.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  Bottle.aggregate.mockResolvedValue([]);
});

const get = (qs = '') => fetch(`${baseUrl}/api/admin/wines/low-confidence${qs}`, {
  headers: { Authorization: `Bearer ${adminToken()}` },
});

describe('GET /low-confidence', () => {
  test('default threshold 0.3, outstanding filter compares reviewedAt against generatedAt', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).threshold).toBe(0.3);

    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.nonWine).toEqual({ $ne: true });
    // Null is MATCHED, not excluded. An unusable model answer (a non-number,
    // or Infinity from a 1e400 in the JSON) sanitises to null, and a
    // `$ne: null` would shut exactly those rows out of the queue built to
    // catch them — sanitising would make them permanently unreviewable.
    expect(filter.$or).toEqual([
      { 'aiProfile.confidence': null },
      { 'aiProfile.confidence': { $lte: 0.3 } },
      // Suspect producers surface REGARDLESS of threshold: the flag is a
      // doubt about the identity, not the profile's confidence — a suspect
      // row can sit at 0.5 while the default threshold is 0.3, and must
      // still appear here.
      { 'aiProfile.producerSuspect': true },
      // Every HELD row surfaces too: an
      // unknown-producer hold can sit at 0.5 with no suspect flag, and this
      // queue is the only place a hold gets released.
      { 'aiProfile.heldAt': { $ne: null } },
    ]);
    // Scoped to rows that were actually enriched, or every un-enriched wine
    // would match the null branch.
    expect(filter['aiProfile.generatedAt']).toEqual({ $ne: null });
    // The self-invalidation contract: suppression is a COMPARISON, so a
    // re-enriched profile (new generatedAt) re-surfaces the row with no hook.
    // Beside it: a published profile with a flagged producer stays until
    // someone rules on the flag, whatever its stamp says. That is the
    // curator queue's rule, so both queues are done with a wine together.
    expect(filter.$expr).toEqual({
      $or: [
        {
          $or: [
            { $eq: ['$profileReviewedAt', null] },
            { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
          ],
        },
        {
          $and: [
            { $eq: [{ $ifNull: ['$aiProfile.heldAt', null] }, null] },
            { $eq: ['$aiProfile.producerSuspect', true] },
            { $gt: [{ $ifNull: ['$aiProfile.description', ''] }, ''] },
            { $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] },
          ],
        },
      ],
    });
  });

  test('threshold is clamped and junk falls back to the default', async () => {
    expect((await (await get('?threshold=0.4')).json()).threshold).toBe(0.4);
    expect((await (await get('?threshold=7')).json()).threshold).toBe(1);
    expect((await (await get('?threshold=-2')).json()).threshold).toBe(0);
    expect((await (await get('?threshold=abc')).json()).threshold).toBe(0.3);
    expect((await (await get('?threshold[$gt]=')).json()).threshold).toBe(0.3);
  });

  test('?includeReviewed=1 drops the comparison clause (audit view)', async () => {
    await get('?includeReviewed=1');
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.$expr).toBeUndefined();
    // Null is MATCHED, not excluded. An unusable model answer (a non-number,
    // or Infinity from a 1e400 in the JSON) sanitises to null, and a
    // `$ne: null` would shut exactly those rows out of the queue built to
    // catch them — sanitising would make them permanently unreviewable.
    expect(filter.$or).toEqual([
      { 'aiProfile.confidence': null },
      { 'aiProfile.confidence': { $lte: 0.3 } },
      // Suspect producers surface REGARDLESS of threshold: the flag is a
      // doubt about the identity, not the profile's confidence — a suspect
      // row can sit at 0.5 while the default threshold is 0.3, and must
      // still appear here.
      { 'aiProfile.producerSuspect': true },
      // Every HELD row surfaces too: an
      // unknown-producer hold can sit at 0.5 with no suspect flag, and this
      // queue is the only place a hold gets released.
      { 'aiProfile.heldAt': { $ne: null } },
    ]);
    // Scoped to rows that were actually enriched, or every un-enriched wine
    // would match the null branch.
    expect(filter['aiProfile.generatedAt']).toEqual({ $ne: null });
  });

  test('rows carry the model doubt fields and bottle counts', async () => {
    WineDefinition.find.mockReturnValue(listChain([{
      _id: WINE_ID, name: 'Le Valet d’Épée', producer: 'Arcane',
      aiProfile: { confidence: 0.2, description: 'hedge', producerSuspect: true, producerNote: 'Arcane is a range of Xavier Vignon', generatedAt: new Date('2026-07-26T08:57:24Z') },
      profileReviewedAt: null,
    }]));
    Bottle.aggregate.mockResolvedValue([{ _id: WINE_ID, count: 8 }]);

    const data = await (await get()).json();
    expect(data.wines[0]).toMatchObject({
      producer: 'Arcane', confidence: 0.2, producerSuspect: true,
      producerNote: 'Arcane is a range of Xavier Vignon', bottleCount: 8,
    });
  });

  test('each row says whether it is reviewed by the queue\'s own rule: a stamp does not settle a flagged producer', async () => {
    const generatedAt = new Date('2026-07-26T08:00:00Z');
    const after = new Date('2026-07-27T08:00:00Z');
    const row = (name, aiProfile, profileReviewedAt) => ({ _id: WINE_ID, name, producer: 'P', aiProfile: { generatedAt, description: 'd', ...aiProfile }, profileReviewedAt });
    WineDefinition.find.mockReturnValue(listChain([
      row('never reviewed', { confidence: 0.2 }, null),
      row('reviewed', { confidence: 0.2 }, after),
      row('flagged, stamped by a profile write, no verdict', { producerSuspect: true }, after),
      row('flagged and upheld', { producerSuspect: true, suspectDecision: 'upheld' }, after),
      row('held and stamped', { heldAt: generatedAt, producerSuspect: true, description: null }, after),
    ]));

    const data = await (await get('?includeReviewed=1')).json();
    expect(data.wines.map((w) => [w.name, w.reviewed])).toEqual([
      ['never reviewed', false],
      ['reviewed', true],
      ['flagged, stamped by a profile write, no verdict', false],
      ['flagged and upheld', true],
      ['held and stamped', true],
    ]);
    // The verdict is loaded for it.
    expect(WineDefinition.find.mock.results[0].value.select.mock.calls[0][0]).toMatch(/aiProfile\.suspectDecision/);
  });
});

describe('profile-reviewed toggle', () => {
  test('a HELD row is released, not stamped: the review lands only when the publish succeeds', async () => {
    // Stamping first would hide the row from the queue forever when the
    // AI call fails — reviewedAt outruns generatedAt and the incremental job
    // skips held rows by design. The stamp lives
    // inside releaseHeldProfile, on success only.
    const { releaseHeldProfile } = require('../../services/enrichmentJob');
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft', aiProfile: { heldAt: new Date() } }),
    });

    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).profileReviewedAt).toBeNull();
    expect(releaseHeldProfile).toHaveBeenCalledWith(expect.anything());
    // No direct stamp from the route — success stamping is the service’s job.
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  test('a HELD row is not regenerated while automatic AI profiles are off — 409 names the way out', async () => {
    // Somm-owned wine data (enrichmentOnAdd 'off'): a release is a forced AI
    // regeneration, so the route refuses it instead of spending, and says what
    // to do — WineLowConfidenceModal shows this error on the row.
    const aiConfig = require('../../config/aiConfig');
    const spy = jest.spyOn(aiConfig, 'get').mockReturnValue({ ...aiConfig.getRaw(), enrichmentOnAdd: 'off' });
    try {
      const { releaseHeldProfile } = require('../../services/enrichmentJob');
      WineDefinition.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue({ _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft', aiProfile: { heldAt: new Date() } }),
      });

      const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/by hand/);
      expect(releaseHeldProfile).not.toHaveBeenCalled();
      expect(WineDefinition.updateOne).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('POST records the review with the current time and audits', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: WINE_ID, name: 'Le Valet d’Épée', producer: 'Arcane' }),
    });

    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);

    const [q, update] = WineDefinition.updateOne.mock.calls[0];
    expect(String(q._id)).toBe(WINE_ID);
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.profileReviewed',
      { type: 'wine', id: WINE_ID },
      expect.objectContaining({ producer: 'Arcane' })
    );
  });

  // "This data is correct" on a flagged producer is a verdict on the flag:
  // the same confirm the curator's review_held_profile records.
  test('a published profile with a flagged producer: POST records a confirm, not just a stamp', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: WINE_ID, name: 'Le Valet d’Épée', producer: 'Arcane',
        aiProfile: { heldAt: null, producerSuspect: true, description: 'A Rhône blend.', producerNote: 'Arcane is a range of Xavier Vignon' },
      }),
    });

    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ message: 'Marked reviewed', suspectCleared: true });
    expect(new Date(body.profileReviewedAt).getTime()).not.toBeNaN();

    expect(WineDefinition.updateOne).toHaveBeenCalledTimes(1);
    const [q, update] = WineDefinition.updateOne.mock.calls[0];
    expect(String(q._id)).toBe(WINE_ID);
    expect(update.$set).toMatchObject({
      'aiProfile.producerSuspect': false,
      'aiProfile.suspectDecision': 'confirmed',
      'aiProfile.producerNote': null,
    });
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
    expect(update.$set['aiProfile.suspectDecidedAt']).toBeInstanceOf(Date);
    // One audit row, the decision's own, with the note it cleared.
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.profileReviewed',
      { type: 'wine', id: WINE_ID },
      expect.objectContaining({ decision: 'confirm', state: 'published_suspect', suspectCleared: true, clearedProducerNote: 'Arcane is a range of Xavier Vignon' })
    );
  });

  test('a flagged producer someone already ruled on is stamped like any other row', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft',
        aiProfile: { heldAt: null, producerSuspect: true, description: 'x', suspectDecision: 'upheld' },
      }),
    });
    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).suspectCleared).toBeUndefined();
    expect(WineDefinition.updateOne.mock.calls[0][1]).toEqual({ $set: { profileReviewedAt: expect.any(Date) } });
  });

  test('DELETE nulls the review and audits the undo', async () => {
    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith(
      { _id: WINE_ID }, { $set: { profileReviewedAt: null } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.profileUnreviewed',
      { type: 'wine', id: WINE_ID }, {});
  });

  test('invalid id → 400; unknown id → 404 on both verbs', async () => {
    expect((await fetch(`${baseUrl}/api/admin/wines/nope/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(400);

    WineDefinition.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    expect((await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(404);

    WineDefinition.updateOne.mockResolvedValue({ matchedCount: 0 });
    expect((await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(404);
  });
});
