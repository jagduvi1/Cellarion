/**
 * Contributing wines made on a self-hosted install to the shared registry, on
 * a REAL MongoDB: the install half (queue, send, sync, link) and the registry
 * half (the request, and its windows becoming suggestions on resolve).
 *
 * WHY THIS TEST EXISTS:
 * The promise to self-hosters is narrow and every part of it is a query:
 *   - only wines made HERE are offered (never a registry copy, a pending or a
 *     draft row), and only when an admin asks;
 *   - sending stops short of the day's allowance, because a 429 makes the
 *     install back off from every bridge call, add-bottle search included;
 *   - on approval the wine HERE is linked, not copied: its _id (and so its
 *     bottles) stays, it takes the identity the registry approved, and what
 *     was set here (a reviewed drink window, a curated tasting profile) stays;
 *   - an approval for a wine this install already holds as a copy is not
 *     merged behind anyone's back;
 *   - on the registry, contributed windows are never published: they become
 *     PENDING suggestions, and a window a curator already reviewed is never
 *     touched.
 * Missing-vs-null fields, nested-field sorts and subdocument $set casting are
 * exactly what mocked models cannot show. Only the transport between the two
 * servers is a stand-in.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_contributions`, dropped before and after. Skipped without it.
 */
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  fetchWine: jest.fn(), search: jest.fn(), changes: jest.fn(), me: jest.fn(),
  forwardCorrection: jest.fn(), forwardValue: jest.fn(), forwardRequest: jest.fn(),
  forwardContribution: jest.fn(), requestStatuses: jest.fn(),
  transportState: jest.fn(() => ({ enabled: true, reason: null })),
}));
// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined), removeWine: jest.fn() }));
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));

const mongoose = require('mongoose');
const client = require('./registryBridgeClient');
const bridge = require('./registryBridge');
const ops = require('./registryContributionOps');
const { parseContribution, fileContribution } = require('./registryContributionIntake');
const { completeRequestResolve } = require('./wineRequestOps');
const { findOrCreateCountry } = require('./findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineRequest = require('../models/WineRequest');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_contributions'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/registryContributionOps.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const USER = new mongoose.Types.ObjectId();
let n = 0;
const rid = () => { n += 1; return n.toString(16).padStart(24, 'c'); };
const NOTE = bridge.REGISTRY_NOTE;

const registryWine = (id, over = {}) => ({
  id, slug: `domaine-example-${id.slice(-4)}`, producer: 'Domaine Example', name: 'Clos Example', type: 'red', appellation: 'Gevrey-Chambertin',
  classification: null, region: 'Burgundy', country: 'France', grapes: ['Pinot Noir'], image: null, imageCredit: null, lwin: null,
  profile: { description: 'The registry\'s prose.', body: 'medium', source: 'ai' }, windows: [], values: [],
  ...over,
});

describeWithMongo('contributions (real MongoDB)', () => {
  let france;

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    await WineDefinition.syncIndexes();
    await WineVintageProfile.syncIndexes();
    france = await findOrCreateCountry('France', USER);
  }, 60000);

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 60000);

  describe('the install: offering a wine made here', () => {
    beforeEach(async () => {
      jest.clearAllMocks();
      ops._reset();
      bridge._reset();
      client.isEnabled.mockReturnValue(true);
      client.me.mockResolvedValue({ usage: { used: { contributions: 0 }, caps: { contributions: 50 } } });
      await WineDefinition.deleteMany({});
      await WineVintageProfile.deleteMany({});
      await WineRequest.deleteMany({});
    });

    const localWine = (name, over = {}) => WineDefinition.create({
      name, producer: 'Domaine Example', appellation: 'Gevrey-Chambertin', type: 'red', country: france._id,
      normalizedKey: generateWineKey(name, 'Domaine Example', 'Gevrey-Chambertin'), createdBy: USER, createdVia: 'ui',
      ...over,
    });
    const reload = (id) => WineDefinition.findById(id).lean();

    test('"all" offers only complete wines made here: never a registry copy, a pending row, or one already offered', async () => {
      const made = await localWine('Clos Example');
      const keyless = await localWine('Les Champs');
      await WineDefinition.collection.updateOne({ _id: keyless._id }, { $unset: { registryId: '' } });
      const nulled = await localWine('Aux Échézeaux');
      await WineDefinition.collection.updateOne({ _id: nulled._id }, { $set: { registryId: null } });
      const copy = await localWine('Copied', { createdVia: 'bridge', registryId: rid() });
      const linked = await localWine('Linked', { registryId: rid() });
      await WineDefinition.collection.insertOne({
        name: 'Half known', producer: '', pendingIdentity: true, normalizedKey: `pending~${USER}:half known:`, createdBy: USER, country: france._id,
      });
      const offered = await localWine('Already', { registryContribution: { status: 'sent', requestId: rid(), sentAt: new Date() } });

      const r = await ops.queueContributions({ all: true, req: null });
      expect(r).toMatchObject({ ok: true, queued: 3 });
      expect(new Set(r.ids)).toEqual(new Set([made, keyless, nulled].map((w) => String(w._id))));
      for (const w of [copy, linked]) expect((await reload(w._id)).registryContribution).toBeUndefined();
      expect((await reload(offered._id)).registryContribution.status).toBe('sent');
      expect((await reload(made._id)).registryContribution).toMatchObject({ status: 'queued', queuedAt: expect.any(Date) });
      expect((await ops.contributionOverview()).counts).toMatchObject({ queued: 3, sent: 1 });
    });

    test('a declined wine may be offered again by id; a sent one may not; an unknown id list is invalid', async () => {
      const declined = await localWine('Declined', { registryContribution: { status: 'declined', notes: 'No such wine.' } });
      const sent = await localWine('Sent', { registryContribution: { status: 'sent', requestId: rid() } });
      const r = await ops.queueContributions({ wineIds: [String(declined._id), String(sent._id)] });
      expect(r).toMatchObject({ ok: true, queued: 1, ids: [String(declined._id)] });
      expect((await reload(declined._id)).registryContribution).toMatchObject({ status: 'queued' });
      expect((await reload(declined._id)).registryContribution.notes == null).toBe(true);
      expect(await ops.queueContributions({ wineIds: ['nope'] })).toEqual({ ok: false, code: 'invalid' });
      client.isEnabled.mockReturnValue(false);
      expect(await ops.queueContributions({ all: true })).toEqual({ ok: false, code: 'disabled' });
    });

    test('a send carries the identity and only the windows reviewed here, and stops short of the day\'s allowance', async () => {
      const a = await localWine('Clos Example', { grapes: [] });
      const b = await localWine('Les Champs');
      const c = await localWine('Aux Échézeaux');
      await WineVintageProfile.create([
        { wineDefinition: a._id, vintage: '2019', status: 'reviewed', peakFrom: 2026, peakUntil: 2034, earlyFrom: 2023, earlyUntil: 2026 },
        { wineDefinition: a._id, vintage: '2020', status: 'pending' },
        { wineDefinition: a._id, vintage: 'NV', status: 'reviewed', relative: true, peakFrom: 1, peakUntil: 4 },
      ]);
      await ops.queueContributions({ all: true });
      // 50 a day, 38 spent, 10 kept for members' own requests → 2 go now.
      client.me.mockResolvedValue({ usage: { used: { contributions: 38 }, caps: { contributions: 50 } } });
      let k = 0;
      client.forwardContribution.mockImplementation(async () => { k += 1; return { ok: true, status: 201, body: { request: { id: String(k).padStart(24, 'e'), status: 'pending' } } }; });

      expect(await ops.sendQueued()).toEqual({ sent: 2, failed: 0 });
      expect(client.forwardContribution).toHaveBeenCalledTimes(2);
      const first = client.forwardContribution.mock.calls[0][0];
      expect(first).toEqual({
        name: 'Clos Example', producer: 'Domaine Example', country: 'France', appellation: 'Gevrey-Chambertin', type: 'red',
        windows: [{ vintage: '2019', early: { from: 2023, until: 2026 }, peak: { from: 2026, until: 2034 } }],
      });
      expect((await reload(a._id)).registryContribution).toMatchObject({ status: 'sent', requestId: '1'.padStart(24, 'e') });
      expect((await reload(b._id)).registryContribution.status).toBe('sent');
      expect((await reload(c._id)).registryContribution.status).toBe('queued');

      // Nothing left of today's allowance: nothing is claimed, nothing sent.
      client.me.mockResolvedValue({ usage: { used: { contributions: 41 }, caps: { contributions: 50 } } });
      expect(await ops.sendQueued()).toEqual({ skipped: 'quota' });
      expect((await reload(c._id)).registryContribution.status).toBe('queued');
    });

    test('a refusal marks the wine failed with the registry\'s words; an unreachable registry puts it back and ends the run', async () => {
      const a = await localWine('Clos Example');
      const b = await localWine('Les Champs');
      await ops.queueContributions({ wineIds: [String(a._id)] });
      await ops.queueContributions({ wineIds: [String(b._id)] });
      client.forwardContribution
        .mockResolvedValueOnce({ ok: false, status: 400, code: 'invalid', message: 'producer is required (at most 200 characters)' })
        .mockResolvedValueOnce({ ok: false, status: 0, code: 'network', message: 'timeout' });
      expect(await ops.sendQueued()).toEqual({ sent: 0, failed: 1 });
      expect((await reload(a._id)).registryContribution).toMatchObject({ status: 'failed', notes: 'producer is required (at most 200 characters)' });
      expect((await reload(b._id)).registryContribution).toMatchObject({ status: 'queued', sentAt: null });
    });

    test('`ids` sends that wine, not the oldest in the queue', async () => {
      const older = await localWine('Older');
      const mine = await localWine('Mine');
      await ops.queueContributions({ wineIds: [String(older._id)] });
      const r = await ops.queueContributions({ wineIds: [String(mine._id)] });
      client.forwardContribution.mockResolvedValue({ ok: true, status: 201, body: { request: { id: 'f'.repeat(24) } } });
      await ops.sendQueued({ max: 1, ids: r.ids });
      expect(client.forwardContribution.mock.calls[0][0].name).toBe('Mine');
      expect((await reload(older._id)).registryContribution.status).toBe('queued');
    });

    test('an approval links the wine here: same _id, the approved identity, its own window and curated profile kept', async () => {
      const wine = await localWine('Clos Exemple', {
        aiProfile: { description: 'Notes written on this install.', source: 'curator' },
        registryContribution: { status: 'sent', requestId: 'a'.repeat(24), sentAt: new Date() },
      });
      await WineVintageProfile.create({ wineDefinition: wine._id, vintage: '2019', status: 'reviewed', peakFrom: 2027, peakUntil: 2033, setBy: USER, setAt: new Date() });
      const RID = rid();
      client.requestStatuses.mockResolvedValue([{ id: 'a'.repeat(24), status: 'resolved', notes: null, wine: { id: RID, name: 'Clos Example' } }]);
      client.fetchWine.mockResolvedValue(registryWine(RID, {
        name: 'Clos Example Vieilles Vignes',
        windows: [
          { vintage: '2019', relative: false, early: null, peak: { from: 2026, until: 2034 }, late: null },
          { vintage: '2021', relative: false, early: null, peak: { from: 2028, until: 2036 }, late: null },
        ],
      }));

      expect(await ops.syncContributions()).toMatchObject({ checked: 1, linked: 1, declined: 0, duplicates: 0, failures: 0 });
      const linked = await reload(wine._id);
      expect(linked.registryId).toBe(RID);
      expect(linked.registryContribution).toBeUndefined();
      expect(linked.name).toBe('Clos Example Vieilles Vignes');
      expect(linked.normalizedKey).toBe(generateWineKey('Clos Example Vieilles Vignes', 'Domaine Example', 'Gevrey-Chambertin'));
      expect(linked.aiProfile).toMatchObject({ description: 'Notes written on this install.', source: 'curator' });
      expect(await WineDefinition.countDocuments({})).toBe(1);
      const windows = await WineVintageProfile.find({ wineDefinition: wine._id }).sort({ vintage: 1 }).lean();
      expect(windows.map((w) => [w.vintage, w.peakFrom, w.peakUntil, w.sommNotes === NOTE])).toEqual([
        ['2019', 2027, 2033, false],
        ['2021', 2028, 2036, true],
      ]);
    });

    test('an approval for a wine this install already holds as a copy is marked duplicate, never merged', async () => {
      const RID = rid();
      const copy = await localWine('Copied already', { createdVia: 'bridge', registryId: RID });
      const wine = await localWine('Clos Example', { registryContribution: { status: 'sent', requestId: 'b'.repeat(24), sentAt: new Date() } });
      client.requestStatuses.mockResolvedValue([{ id: 'b'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      expect(await ops.syncContributions()).toMatchObject({ duplicates: 1, linked: 0 });
      const after = await reload(wine._id);
      expect(after.registryId == null).toBe(true);
      // The registry id it was approved as, never a reference to the copy: the
    // copy is looked up when the state is read, so a merge here cannot strand it.
    expect(after.registryContribution).toMatchObject({ status: 'duplicate', approvedRegistryId: RID });
    expect(after.registryContribution).not.toHaveProperty('duplicateOf');
    expect((await ops.contributionForWine(wine._id)).contribution).toMatchObject({ status: 'duplicate', duplicateOf: String(copy._id) });
      expect(client.fetchWine).not.toHaveBeenCalled();
      const overview = await ops.contributionOverview();
      expect(overview.attention).toEqual([expect.objectContaining({ id: String(wine._id), status: 'duplicate', duplicateOf: String(copy._id) })]);
    });

    test('a decline keeps the registry\'s reason; a request still pending is only stamped; an unreachable registry changes nothing', async () => {
      const declined = await localWine('Declined', { registryContribution: { status: 'sent', requestId: 'c'.repeat(24), sentAt: new Date() } });
      const waiting = await localWine('Waiting', { registryContribution: { status: 'sent', requestId: 'd'.repeat(24), sentAt: new Date() } });
      client.requestStatuses.mockResolvedValue([
        { id: 'c'.repeat(24), status: 'rejected', notes: 'Not a wine we could find anywhere.' },
        { id: 'd'.repeat(24), status: 'pending' },
      ]);
      expect(await ops.syncContributions()).toMatchObject({ checked: 2, declined: 1 });
      expect((await reload(declined._id)).registryContribution).toMatchObject({ status: 'declined', notes: 'Not a wine we could find anywhere.' });
      expect((await reload(waiting._id)).registryContribution).toMatchObject({ status: 'sent', checkedAt: expect.any(Date) });

      client.requestStatuses.mockResolvedValue(null);
      expect(await ops.syncContributions()).toMatchObject({ checked: 0, failed: true });
    });

    test('an offer nothing on cellarion.app waits on can be taken back; a sent one cannot', async () => {
      const queued = await localWine('Queued', { registryContribution: { status: 'queued', queuedAt: new Date() } });
      const sent = await localWine('Sent', { registryContribution: { status: 'sent', requestId: rid() } });
      expect(await ops.withdrawContribution({ wineId: String(queued._id) })).toEqual({ ok: true });
      expect((await reload(queued._id)).registryContribution).toBeUndefined();
      expect(await ops.withdrawContribution({ wineId: String(sent._id) })).toEqual({ ok: false, code: 'sent' });
      expect(await ops.withdrawContribution({ wineId: String(queued._id) })).toEqual({ ok: false, code: 'not_found' });
    });

    test('the wine page state: offerable, then queued; a registry copy is linked and not offerable', async () => {
      const mine = await localWine('Mine');
      const copy = await localWine('Copied', { createdVia: 'bridge', registryId: rid() });
      expect(await ops.contributionForWine(mine._id)).toEqual({ enabled: true, linked: false, offerable: true, contribution: null });
      await ops.queueContributions({ wineIds: [String(mine._id)] });
      expect(await ops.contributionForWine(mine._id)).toMatchObject({ offerable: false, contribution: { status: 'queued' } });
      expect(await ops.contributionForWine(copy._id)).toMatchObject({ linked: true, offerable: false });
      client.isEnabled.mockReturnValue(false);
      expect(await ops.contributionForWine(mine._id)).toEqual({ enabled: false });
    });
  });

  describe('the registry: a contribution resolved', () => {
    beforeEach(async () => {
      await WineDefinition.deleteMany({});
      await WineVintageProfile.deleteMany({});
      await WineRequest.deleteMany({});
    });

    test('its windows become pending suggestions; a reviewed window and one with content are never touched', async () => {
      const { contribution } = parseContribution({
        name: 'Clos Example', producer: 'Domaine Example',
        windows: [
          { vintage: '2018', peak: { from: 2024, until: 2030 } },
          { vintage: '2019', peak: { from: 2026, until: 2034 } },
          { vintage: '2020', peak: { from: 2027, until: 2035 } },
          { vintage: '2021', peak: { from: 2028, until: 2036 } },
        ],
      });
      const req = { bridge: { key: { id: new mongoose.Types.ObjectId(), instanceHost: 'cellar.example.org' } } };
      const { wineRequest } = await fileContribution(USER, contribution, { via: 'bridge', req });
      expect(wineRequest.installFollowsAt).toBeInstanceOf(Date);

      const wine = await WineDefinition.create({
        name: 'Clos Example', producer: 'Domaine Example', country: france._id, type: 'red',
        normalizedKey: generateWineKey('Clos Example', 'Domaine Example', ''), createdBy: USER,
      });
      const curator = new mongoose.Types.ObjectId();
      await WineVintageProfile.create([
        { wineDefinition: wine._id, vintage: '2018', status: 'reviewed', peakFrom: 2023, peakUntil: 2029, setBy: curator, setAt: new Date() },
        { wineDefinition: wine._id, vintage: '2019', status: 'pending' },
        { wineDefinition: wine._id, vintage: '2020', status: 'pending', peakFrom: 2030, peakUntil: 2040, setBy: curator },
      ]);

      const loaded = await WineRequest.findById(wineRequest._id);
      expect(await completeRequestResolve(loaded, wine, { resolvedBy: curator })).toEqual({ backfilledCount: 0 });

      const rows = await WineVintageProfile.find({ wineDefinition: wine._id }).sort({ vintage: 1 }).lean();
      expect(rows.map((r) => [r.vintage, r.status, r.peakFrom, r.peakUntil, String(r.setBy)])).toEqual([
        ['2018', 'reviewed', 2023, 2029, String(curator)],
        ['2019', 'pending', 2026, 2034, String(USER)],
        ['2020', 'pending', 2030, 2040, String(curator)],
        ['2021', 'pending', 2028, 2036, String(USER)],
      ]);
      expect((await WineRequest.findById(wineRequest._id).lean()).status).toBe('resolved');
    });
  });
});
