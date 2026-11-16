/**
 * Contributing wines made on a self-hosted install to the shared registry, on
 * a REAL MongoDB: the install half (queue, send, sync, link) and the registry
 * half (the request, and its windows becoming suggestions on resolve).
 *
 * WHY THIS TEST EXISTS:
 * The promise to self-hosters is narrow and every part of it is a query:
 *   - only wines made HERE are offered (never a registry copy, a pending or a
 *     draft row), and only when an admin asks; an offer taken back stays out
 *     of "offer every wine";
 *   - sending stops short of the day's allowance, because a 429 makes the
 *     install back off from every bridge call, add-bottle search included;
 *     a wine that cannot be sent never holds the front of the queue;
 *   - on approval the wine HERE is linked, not copied: its _id (and so its
 *     bottles) stays, it takes the identity the registry approved, and what
 *     was set here stays: a reviewed drink window, a curated tasting profile
 *     (also at every later refresh), and extras the registry wine lacks;
 *   - a link cut short is finished by the next sync; an approval for a wine
 *     this install already holds as a copy is not merged behind anyone's back,
 *     and is linked once that copy is gone; an offer nobody will ever answer
 *     ends as failed instead of waiting for good;
 *   - on the registry, contributed windows are never published: they are a
 *     SUGGESTION beside the window, which only a curator's own write fills,
 *     and a window a curator already reviewed is never touched.
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
const maturityOps = require('./maturityOps');
const { parseContribution, fileContribution } = require('./registryContributionIntake');
const { completeRequestResolve } = require('./wineRequestOps');
const { findOrCreateCountry, findOrCreateRegion } = require('./findOrCreateWine');
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
const FAST = { pauseMs: 0 };

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
    const sentState = (requestId, over = {}) => ({ registryContribution: { status: 'sent', requestId, sentAt: new Date(), ...over } });

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
      const offered = await localWine('Already', sentState(rid()));

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
      const sent = await localWine('Sent', sentState(rid()));
      const r = await ops.queueContributions({ wineIds: [String(declined._id), String(sent._id)] });
      expect(r).toMatchObject({ ok: true, queued: 1, ids: [String(declined._id)] });
      expect((await reload(declined._id)).registryContribution).toMatchObject({ status: 'queued' });
      expect((await reload(declined._id)).registryContribution.notes == null).toBe(true);
      expect(await ops.queueContributions({ wineIds: ['nope'] })).toEqual({ ok: false, code: 'invalid' });
      client.isEnabled.mockReturnValue(false);
      expect(await ops.queueContributions({ all: true })).toEqual({ ok: false, code: 'disabled' });
    });

    test('a send carries the identity, its own id and only the windows reviewed here, and stops short of the day\'s allowance', async () => {
      const a = await localWine('Clos Example', { grapes: [], lwin: { lwin7: '1234567' } });
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

      expect(await ops.sendQueued(FAST)).toEqual({ sent: 2, failed: 0 });
      expect(client.forwardContribution).toHaveBeenCalledTimes(2);
      expect(client.forwardContribution.mock.calls[0][0]).toEqual({
        ref: String(a._id), name: 'Clos Example', producer: 'Domaine Example', country: 'France', appellation: 'Gevrey-Chambertin', type: 'red',
        lwin: '1234567',
        windows: [{ vintage: '2019', early: { from: 2023, until: 2026 }, peak: { from: 2026, until: 2034 } }],
      });
      expect((await reload(a._id)).registryContribution).toMatchObject({ status: 'sent', requestId: '1'.padStart(24, 'e') });
      expect((await reload(b._id)).registryContribution.status).toBe('sent');
      expect((await reload(c._id)).registryContribution.status).toBe('queued');

      // Nothing left of today's allowance: nothing is claimed, nothing sent.
      client.me.mockResolvedValue({ usage: { used: { contributions: 41 }, caps: { contributions: 50 } } });
      expect(await ops.sendQueued(FAST)).toEqual({ skipped: 'quota' });
      expect((await reload(c._id)).registryContribution.status).toBe('queued');
    });

    test('a refusal marks the wine failed with the registry\'s words; one that got no answer goes to the back and ends the run', async () => {
      const a = await localWine('Clos Example');
      const b = await localWine('Les Champs');
      const c = await localWine('Aux Échézeaux');
      for (const w of [a, b, c]) await ops.queueContributions({ wineIds: [String(w._id)] });
      client.forwardContribution
        .mockResolvedValueOnce({ ok: false, status: 400, code: 'invalid', message: 'producer is required (at most 200 characters)' })
        .mockResolvedValueOnce({ ok: false, status: 0, code: 'network', message: 'timeout' });
      expect(await ops.sendQueued(FAST)).toEqual({ sent: 0, failed: 1 });
      expect((await reload(a._id)).registryContribution).toMatchObject({ status: 'failed', notes: 'producer is required (at most 200 characters)' });
      const bAfter = (await reload(b._id)).registryContribution;
      const cAfter = (await reload(c._id)).registryContribution;
      expect(bAfter).toMatchObject({ status: 'queued', sentAt: null, attempts: 1 });
      // Behind c now: a wine that keeps failing never holds the front.
      expect(bAfter.queuedAt.getTime()).toBeGreaterThan(cAfter.queuedAt.getTime());
    });

    test('a wine that never gets an answer is failed after the limit; a send the client never made does not count', async () => {
      const w = await localWine('Clos Example', { registryContribution: { status: 'queued', queuedAt: new Date(), attempts: ops.ATTEMPT_LIMIT - 1 } });
      client.forwardContribution.mockResolvedValueOnce({ ok: false, status: 0, code: 'quota', message: 'bridge backing off' });
      await ops.sendQueued(FAST);
      expect((await reload(w._id)).registryContribution).toMatchObject({ status: 'queued', attempts: ops.ATTEMPT_LIMIT - 1 });
      client.forwardContribution.mockResolvedValueOnce({ ok: false, status: 502, code: 'error', message: 'Bad gateway' });
      await ops.sendQueued(FAST);
      expect((await reload(w._id)).registryContribution).toMatchObject({ status: 'failed', attempts: ops.ATTEMPT_LIMIT, notes: expect.stringContaining('HTTP 502') });
    });

    test('`ids` sends that wine, not the oldest in the queue', async () => {
      const older = await localWine('Older');
      const mine = await localWine('Mine');
      await ops.queueContributions({ wineIds: [String(older._id)] });
      const r = await ops.queueContributions({ wineIds: [String(mine._id)] });
      client.forwardContribution.mockResolvedValue({ ok: true, status: 201, body: { request: { id: 'f'.repeat(24) } } });
      await ops.sendQueued({ max: 1, ids: r.ids, ...FAST });
      expect(client.forwardContribution.mock.calls[0][0].name).toBe('Mine');
      expect((await reload(older._id)).registryContribution.status).toBe('queued');
    });

    test('an approval links the wine here: same _id, the approved identity, its own window and curated profile kept', async () => {
      const wine = await localWine('Clos Exemple', {
        aiProfile: { description: 'Notes written on this install.', source: 'curator' },
        ...sentState('a'.repeat(24)),
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

      expect(await ops.syncContributions(FAST)).toMatchObject({ checked: 1, linked: 1, declined: 0, duplicates: 0, failures: 0 });
      const linked = await reload(wine._id);
      expect(linked.registryId).toBe(RID);
      expect(linked.registryContribution).toBeUndefined();
      expect(linked.name).toBe('Clos Example Vieilles Vignes');
      expect(linked.normalizedKey).toBe(generateWineKey('Clos Example Vieilles Vignes', 'Domaine Example', 'Gevrey-Chambertin'));
      expect(linked.aiProfile).toMatchObject({ description: 'Notes written on this install.', source: 'curator', heldLocally: true });
      expect(await WineDefinition.countDocuments({})).toBe(1);
      const windows = await WineVintageProfile.find({ wineDefinition: wine._id }).sort({ vintage: 1 }).lean();
      expect(windows.map((w) => [w.vintage, w.peakFrom, w.peakUntil, w.sommNotes === NOTE])).toEqual([
        ['2019', 2027, 2033, false],
        ['2021', 2028, 2036, true],
      ]);

      // The weekly refresh after the registry wine changed: the profile
      // curated here stays, not only at the link.
      client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: new Date(Date.now() + 60000).toISOString() }], removed: [], checked: 1, checkedAt: new Date().toISOString() });
      client.fetchWine.mockResolvedValue(registryWine(RID, { name: 'Clos Example Vieilles Vignes', profile: { description: 'Newer registry prose.', body: 'full', source: 'curator' } }));
      expect(await bridge.refreshHeld({ now: new Date() })).toMatchObject({ failures: 0 });
      expect((await reload(wine._id)).aiProfile).toMatchObject({ description: 'Notes written on this install.', heldLocally: true });
    });

    test('a link keeps extras the registry wine lacks: LWIN, region, classification', async () => {
      const burgundy = await findOrCreateRegion('Burgundy', france._id, USER);
      const wine = await localWine('Clos Example', {
        lwin: { lwin7: '7654321' }, region: burgundy._id, classification: 'Premier Cru',
        ...sentState('b'.repeat(24)),
      });
      const RID = rid();
      client.requestStatuses.mockResolvedValue([{ id: 'b'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      client.fetchWine.mockResolvedValue(registryWine(RID, { region: null, appellation: 'Gevrey-Chambertin', lwin: null, classification: null }));
      expect(await ops.syncContributions(FAST)).toMatchObject({ linked: 1 });
      const linked = await reload(wine._id);
      expect(linked.lwin).toEqual({ lwin7: '7654321' });
      expect(String(linked.region)).toBe(String(burgundy._id));
      expect(linked.classification).toBe('Premier Cru');
    });

    test('a link cut short (registry id set, no sync stamp) is finished by the next sync', async () => {
      const RID = rid();
      const wine = await localWine('Clos Exemple', { registryId: RID, registrySyncedAt: null, ...sentState('c'.repeat(24)) });
      client.requestStatuses.mockResolvedValue([{ id: 'c'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      client.fetchWine.mockResolvedValue(registryWine(RID, { name: 'Clos Example' }));
      expect(await ops.syncContributions(FAST)).toMatchObject({ linked: 1 });
      const linked = await reload(wine._id);
      expect(linked).toMatchObject({ registryId: RID, name: 'Clos Example' });
      expect(linked.registrySyncedAt).toBeInstanceOf(Date);
      expect(linked.registryContribution).toBeUndefined();
    });

    test('a wine an adoption already linked to the same registry wine is only finished: its stamps stay the bridge\'s', async () => {
      const RID = rid();
      const syncedAt = new Date(Date.now() - 60000);
      const wine = await localWine('Clos Example', { registryId: RID, registrySyncedAt: syncedAt, ...sentState('d'.repeat(24)) });
      client.requestStatuses.mockResolvedValue([{ id: 'd'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      expect(await ops.syncContributions(FAST)).toMatchObject({ linked: 1 });
      expect(client.fetchWine).not.toHaveBeenCalled();
      const after = await reload(wine._id);
      expect(after.registrySyncedAt.getTime()).toBe(syncedAt.getTime());
      expect(after.registryContribution).toBeUndefined();
    });

    test('an approval for a wine this install already holds as a copy is marked duplicate; once the copy is gone it is linked', async () => {
      const RID = rid();
      const copy = await localWine('Copied already', { createdVia: 'bridge', registryId: RID });
      const wine = await localWine('Clos Example', sentState('e'.repeat(24)));
      client.requestStatuses.mockResolvedValue([{ id: 'e'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      expect(await ops.syncContributions(FAST)).toMatchObject({ duplicates: 1, linked: 0 });
      const after = await reload(wine._id);
      expect(after.registryId == null).toBe(true);
      // The registry id it was approved as, never a reference to the copy: the
      // copy is looked up when the state is read, so a merge here cannot strand it.
      expect(after.registryContribution).toMatchObject({ status: 'duplicate', approvedRegistryId: RID });
      expect(after.registryContribution).not.toHaveProperty('duplicateOf');
      expect(client.fetchWine).not.toHaveBeenCalled();
      expect((await ops.contributionForWine(wine._id)).contribution).toMatchObject({ status: 'duplicate', duplicateOf: String(copy._id) });
      expect((await ops.contributionOverview()).attention).toEqual([expect.objectContaining({ id: String(wine._id), status: 'duplicate', duplicateOf: String(copy._id) })]);

      // An admin here merges the copy away: the next sync links the wine.
      await WineDefinition.deleteOne({ _id: copy._id });
      client.requestStatuses.mockResolvedValue([]);
      client.fetchWine.mockResolvedValue(registryWine(RID));
      expect(await ops.syncContributions(FAST)).toMatchObject({ linked: 1 });
      expect(await reload(wine._id)).toMatchObject({ registryId: RID });
      expect((await reload(wine._id)).registryContribution).toBeUndefined();
    });

    test('a decline keeps the registry\'s reason; a request still pending is only stamped; an unreachable registry changes nothing', async () => {
      const declined = await localWine('Declined', sentState('f'.repeat(24)));
      const waiting = await localWine('Waiting', sentState('9'.repeat(24), { misses: 3 }));
      client.requestStatuses.mockResolvedValue([
        { id: 'f'.repeat(24), status: 'rejected', notes: 'Not a wine we could find anywhere.' },
        { id: '9'.repeat(24), status: 'pending' },
      ]);
      expect(await ops.syncContributions(FAST)).toMatchObject({ checked: 2, declined: 1 });
      expect((await reload(declined._id)).registryContribution).toMatchObject({ status: 'declined', notes: 'Not a wine we could find anywhere.' });
      expect((await reload(waiting._id)).registryContribution).toMatchObject({ status: 'sent', checkedAt: expect.any(Date), misses: 0 });

      client.requestStatuses.mockResolvedValue(null);
      expect(await ops.syncContributions(FAST)).toMatchObject({ checked: 0, failed: true });
    });

    test('an offer the registry no longer knows ends as failed after the limit; one approved as a vanished wine at once', async () => {
      const unknown = await localWine('Unknown', sentState('8'.repeat(24), { misses: ops.MISS_LIMIT - 1 }));
      const vanished = await localWine('Vanished', sentState('7'.repeat(24)));
      const RID = rid();
      client.requestStatuses.mockResolvedValue([{ id: '7'.repeat(24), status: 'resolved', wine: { id: RID } }]);
      client.fetchWine.mockResolvedValue({ removed: true });
      expect(await ops.syncContributions(FAST)).toMatchObject({ checked: 2, expired: 1, failures: 1 });
      expect((await reload(unknown._id)).registryContribution).toMatchObject({ status: 'failed', notes: expect.stringContaining('no longer knows this offer') });
      expect((await reload(vanished._id)).registryContribution).toMatchObject({ status: 'failed', notes: expect.stringContaining('no longer there') });
    });

    test('an offer taken back is "withdrawn": left out of "offer every wine", offerable again by hand; a sent one cannot be taken back', async () => {
      const queued = await localWine('Queued', { registryContribution: { status: 'queued', queuedAt: new Date() } });
      const sent = await localWine('Sent', sentState(rid()));
      expect(await ops.withdrawContribution({ wineId: String(queued._id) })).toEqual({ ok: true });
      expect((await reload(queued._id)).registryContribution).toMatchObject({ status: 'withdrawn' });
      expect(await ops.withdrawContribution({ wineId: String(sent._id) })).toEqual({ ok: false, code: 'sent' });
      expect(await ops.withdrawContribution({ wineId: String(queued._id) })).toEqual({ ok: false, code: 'not_found' });

      expect(await ops.queueContributions({ all: true })).toMatchObject({ queued: 0 });
      const overview = await ops.contributionOverview();
      expect(overview.offerable).toBe(0);
      expect(overview.attention).toEqual([]);
      // On its page it reads as never offered, and may be offered again.
      expect(await ops.contributionForWine(queued._id)).toMatchObject({ offerable: true, contribution: null });
      expect(await ops.queueContributions({ wineIds: [String(queued._id)] })).toMatchObject({ queued: 1 });
    });

    test('an offer on a wine that got linked another way is dropped, so nothing stale lingers', async () => {
      const wine = await localWine('Clos Example', { registryId: rid(), registrySyncedAt: new Date(), registryContribution: { status: 'declined', notes: 'Already in the registry.' } });
      client.requestStatuses.mockResolvedValue([]);
      await ops.syncContributions(FAST);
      expect((await reload(wine._id)).registryContribution).toBeUndefined();
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

    const contribute = async (windows) => {
      const { contribution } = parseContribution({ name: 'Clos Example', producer: 'Domaine Example', windows });
      const req = { bridge: { key: { id: new mongoose.Types.ObjectId(), instanceHost: 'cellar.example.org' } } };
      const { wineRequest } = await fileContribution(USER, contribution, { via: 'bridge', req });
      return wineRequest;
    };
    const registryRow = (over = {}) => WineDefinition.create({
      name: 'Clos Example', producer: 'Domaine Example', country: france._id, type: 'red',
      normalizedKey: generateWineKey('Clos Example', 'Domaine Example', ''), createdBy: USER, ...over,
    });

    test('its windows become suggestions beside the window, never in it; a reviewed row is never touched', async () => {
      const wineRequest = await contribute([
        { vintage: '2018', peak: { from: 2024, until: 2030 } },
        { vintage: '2019', early: { from: 2022, until: 2025 }, peak: { from: 2026, until: 2034 }, late: { from: 2034, until: 2045 } },
        { vintage: '2020', peak: { from: 2027, until: 2035 } },
        { vintage: '2021', peak: { from: 2028, until: 2036 } },
      ]);
      expect(wineRequest.installFollowsAt).toBeInstanceOf(Date);
      const wine = await registryRow();
      const curator = new mongoose.Types.ObjectId();
      await WineVintageProfile.create([
        { wineDefinition: wine._id, vintage: '2018', status: 'reviewed', peakFrom: 2023, peakUntil: 2029, setBy: curator, setAt: new Date() },
        { wineDefinition: wine._id, vintage: '2019', status: 'pending' },
        { wineDefinition: wine._id, vintage: '2020', status: 'pending', peakFrom: 2030, peakUntil: 2040, setBy: curator },
      ]);

      const loaded = await WineRequest.findById(wineRequest._id);
      expect(await completeRequestResolve(loaded, wine, { resolvedBy: curator })).toEqual({ backfilledCount: 0 });

      const rows = await WineVintageProfile.find({ wineDefinition: wine._id }).sort({ vintage: 1 }).lean();
      expect(rows.map((r) => [r.vintage, r.status, r.peakFrom ?? null, r.peakUntil ?? null, r.suggestion ? [r.suggestion.peakFrom, r.suggestion.peakUntil, r.suggestion.source] : null])).toEqual([
        ['2018', 'reviewed', 2023, 2029, null],
        ['2019', 'pending', null, null, [2026, 2034, 'bridge']],
        ['2020', 'pending', 2030, 2040, [2027, 2035, 'bridge']],
        ['2021', 'pending', null, null, [2028, 2036, 'bridge']],
      ]);
      expect(String(rows[1].suggestion.requestId)).toBe(String(wineRequest._id));
      expect(rows[1].setBy == null).toBe(true);
      expect((await WineRequest.findById(wineRequest._id).lean()).status).toBe('resolved');

      // A curator who sets only the peak publishes only the peak: the rest of
      // the install's proposal never becomes part of the window.
      const row2019 = await WineVintageProfile.findById(rows[1]._id);
      const merged = maturityOps.mergeWindow(row2019, { peakFrom: 2027, peakUntil: 2035 });
      expect(merged.ok).toBe(true);
      await maturityOps.applyWindow(row2019, merged.next, { actorId: curator, req: null });
      const reviewed = await WineVintageProfile.findById(rows[1]._id).lean();
      expect(reviewed).toMatchObject({ status: 'reviewed', peakFrom: 2027, peakUntil: 2035 });
      expect(reviewed.earlyFrom ?? null).toBeNull();
      expect(reviewed.lateFrom ?? null).toBeNull();
      expect(reviewed.suggestion).toBeUndefined();
    });

    test('nothing is seeded for a wine kept out of the maturity queue', async () => {
      const wineRequest = await contribute([{ vintage: '2019', peak: { from: 2026, until: 2034 } }]);
      const wine = await registryRow({ nonWine: true });
      await completeRequestResolve(await WineRequest.findById(wineRequest._id), wine, {});
      expect(await WineVintageProfile.countDocuments({ wineDefinition: wine._id })).toBe(0);
    });
  });
});
