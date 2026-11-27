/**
 * Wines waiting for a curator's check, against a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * A wine taken from a member's own data (models/WineDefinition.uncheckedIdentity)
 * must stay out of the shared registry until a curator has checked it, and the
 * whole rule is queries, keys and one unique index: two members' rows of one
 * wine live side by side, nobody but the creator and curators can load one, an
 * ordinary save never publishes it, the curator's check does, a second row of
 * the same wine is then told it duplicates the published one, and the next
 * member's wine resolves to the published row instead of minting again.
 * Mocked models can show none of that.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_unchecked`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unchecked-wines-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'unchecked-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mongoose = require('mongoose');

// The resolver and the promotion follow-through pull in much of the backend.
jest.setTimeout(60000);

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_unchecked'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/uncheckedWines.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('wines waiting for a curator\'s check (real MongoDB)', () => {
  let WineDefinition; let findOrCreateWine; let ops; let visibility; let generateWineKey;
  const oid = () => new mongoose.Types.ObjectId();
  const [ANNA, BEN, CARL, CURATOR, DELETED] = Array.from({ length: 5 }, oid);
  const IMPORT = { unchecked: true, allowPending: true, createdVia: 'import' };
  const BAROLO = { name: 'Barolo Bussia', producer: 'Cantina Esempio', country: 'Italy', type: 'red' };
  const mint = (identity, userId, opts = IMPORT) => findOrCreateWine({ ...identity }, String(userId), opts);
  const reload = (id) => WineDefinition.findById(id);
  const viewer = (userId, roles = ['user']) => ({ userId: String(userId), roles });
  const bottle = (wineDefinition, user, cellar = oid()) => mongoose.connection.collection('bottles').insertOne({
    user, wineDefinition, cellar, bottleSize: '750ml', status: 'active', vintage: '2019', createdAt: new Date(),
  });

  beforeAll(async () => {
    expect(new URL(URI).pathname).toBe('/cellarion_contract_unchecked');
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    require('../models/Country'); require('../models/Region'); require('../models/Grape');
    WineDefinition = require('../models/WineDefinition');
    await WineDefinition.init();
    ({ findOrCreateWine } = require('./findOrCreateWine'));
    ops = require('./pendingWineOps');
    visibility = require('./wineVisibility');
    ({ generateWineKey } = require('../utils/normalize'));
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let annaWine; let benWine;

  test('a mint is hidden, keeps the file\'s values and keys in the member\'s own namespace', async () => {
    const res = await mint(BAROLO, ANNA);
    expect(res.created).toBe(true);
    expect(res.unchecked).toBe(true);
    annaWine = res.wine._id;

    const row = await reload(annaWine);
    expect(row).toMatchObject({ uncheckedIdentity: true, pendingIdentity: true, draft: false, producer: 'Cantina Esempio', createdVia: 'import' });
    expect(row.normalizedKey).toBe(`unchecked~${ANNA}:cantina esempio:barolo bussia:`);
  });

  test('the same member adding it again gets the same row, not a second one', async () => {
    const res = await mint(BAROLO, ANNA);
    expect(res.created).toBe(false);
    expect(String(res.wine._id)).toBe(String(annaWine));
    expect(await WineDefinition.countDocuments({ uncheckedIdentity: true })).toBe(1);
  });

  test('another member\'s row of the same wine lives beside it', async () => {
    const res = await mint(BAROLO, BEN);
    expect(res.created).toBe(true);
    benWine = res.wine._id;
    expect(String(benWine)).not.toBe(String(annaWine));
    expect((await reload(benWine)).normalizedKey).toBe(`unchecked~${BEN}:cantina esempio:barolo bussia:`);
  });

  test('only the creator and curators can load it', async () => {
    const load = (who) => visibility.findVisibleWine(String(annaWine), who);
    expect(await load(viewer(ANNA))).not.toBeNull();
    expect(await load(viewer(CURATOR, ['somm']))).not.toBeNull();
    expect(await load(viewer(BEN))).toBeNull();
    expect(await load({})).toBeNull();
    // The registry as a stranger queries it holds neither row.
    expect(await WineDefinition.countDocuments(visibility.wineVisibilityFilter(viewer(CARL)))).toBe(0);
  });

  test('a member of a shared cellar that holds a bottle of it can read it', async () => {
    const cellar = oid();
    await mongoose.connection.collection('cellars').insertOne({ _id: cellar, user: CARL, name: 'Shared', members: [{ user: ANNA, role: 'editor' }], deletedAt: null });
    await bottle(annaWine, ANNA, cellar);
    expect(await visibility.findVisibleWine(String(annaWine), viewer(CARL))).toBeNull();
    const seen = await visibility.findVisibleWine(String(annaWine), { ...viewer(CARL), viaSharedCellar: true });
    expect(String(seen._id)).toBe(String(annaWine));
  });

  test('a row with no producer keys in the pending namespace and still waits for the check', async () => {
    const res = await mint({ name: 'Cuvée Sans Nom', producer: 'Unknown', country: 'France' }, ANNA);
    const row = await reload(res.wine._id);
    expect(row).toMatchObject({ uncheckedIdentity: true, pendingIdentity: true, producer: '' });
    expect(row.normalizedKey).toBe(`pending~${ANNA}:cuvee sans nom:`);

    const refused = await ops.applyPendingFix(row, { identityChecked: true }, String(CURATOR));
    expect(refused).toMatchObject({ ok: false, code: 'invalid_input' });
    expect((await reload(res.wine._id)).uncheckedIdentity).toBe(true);
  });

  test('an ordinary save never publishes it, complete identity or not', async () => {
    const row = await reload(annaWine);
    row.appellation = 'Barolo';
    await row.save();
    expect(await reload(annaWine)).toMatchObject({ pendingIdentity: true, uncheckedIdentity: true });
  });

  test('a curator\'s fix without the check writes the fields and keeps it waiting, in its own namespace', async () => {
    const check = ops.validatePendingFix({ name: 'Barolo Bussia Riserva' });
    expect(check.ok).toBe(true);
    const res = await ops.applyPendingFix(await reload(benWine), check.clean, String(CURATOR));
    expect(res).toMatchObject({ ok: true, promoted: false });
    const row = await reload(benWine);
    expect(row).toMatchObject({ name: 'Barolo Bussia Riserva', pendingIdentity: true, uncheckedIdentity: true });
    expect(row.normalizedKey).toBe(`unchecked~${BEN}:cantina esempio:barolo bussia riserva:`);

    // Back to the name the other member's row has, still unchecked.
    await ops.applyPendingFix(await reload(benWine), { name: 'Barolo Bussia', appellation: 'Barolo' }, String(CURATOR));
  });

  test('identityChecked is the only thing that publishes it; only true is accepted', async () => {
    expect(ops.validatePendingFix({ identityChecked: false }).ok).toBe(false);
    const check = ops.validatePendingFix({ identityChecked: true });
    expect(check).toMatchObject({ ok: true, clean: { identityChecked: true } });

    const res = await ops.applyPendingFix(await reload(annaWine), check.clean, String(CURATOR));
    expect(res).toMatchObject({ ok: true, promoted: true });
    expect(res.diff.identityChecked).toEqual({ from: false, to: true });

    const row = await reload(annaWine);
    expect(row).toMatchObject({ pendingIdentity: false, uncheckedIdentity: false });
    expect(row.normalizedKey).toBe(generateWineKey('Barolo Bussia', 'Cantina Esempio', 'Barolo'));
    // Published: a stranger can load it now.
    expect(await visibility.findVisibleWine(String(annaWine), viewer(CARL))).not.toBeNull();
  });

  test('checking the second row of the same wine is refused as a duplicate, and it keeps waiting', async () => {
    const res = await ops.applyPendingFix(await reload(benWine), { identityChecked: true }, String(CURATOR));
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    const row = await reload(benWine);
    expect(row).toMatchObject({ pendingIdentity: true, uncheckedIdentity: true });
    expect(row.normalizedKey).toBe(`unchecked~${BEN}:cantina esempio:barolo bussia:barolo`);
  });

  test('the next member\'s wine resolves to the published row instead of minting', async () => {
    const res = await mint({ ...BAROLO, appellation: 'Barolo' }, CARL);
    expect(res.created).toBe(false);
    expect(String(res.wine._id)).toBe(String(annaWine));
  });

  test('the queue lists waiting rows and marks them', async () => {
    const { rows } = await ops.queryPendingWines({ limit: 50 });
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    expect(byId.get(String(benWine))).toMatchObject({ unchecked: true, producer: 'Cantina Esempio', createdVia: 'import' });
    expect(byId.has(String(annaWine))).toBe(false);
  });

  describe('the member\'s own data: export and erasure', () => {
    let entry; let held; let empty;
    const ctxFor = (userId) => ({ userId, deletedUserId: DELETED, truncated: {} });

    beforeAll(async () => {
      const { REGISTRY } = require('./userDataRegistry');
      entry = REGISTRY.find((e) => e.model === WineDefinition);
      held = (await mint({ name: 'Riesling Held', producer: 'Weingut Beispiel', country: 'Germany' }, BEN)).wine._id;
      empty = (await mint({ name: 'Riesling Empty', producer: 'Weingut Beispiel', country: 'Germany' }, BEN)).wine._id;
      // Another member's bottle, in a shared cellar, still points at one of them.
      await bottle(held, CARL);
    });

    test('the export lists the member\'s unchecked wines', async () => {
      const out = await entry.exportFragment(ctxFor(BEN));
      expect(out.uncheckedWines.map((w) => w.name).sort()).toEqual(['Barolo Bussia', 'Riesling Empty', 'Riesling Held']);
      expect(out.uncheckedWines[0]).toEqual(expect.objectContaining({ producer: expect.any(String), country: expect.any(String), createdVia: 'import' }));
      expect(out.draftWines).toEqual([]);
    });

    test('erasure deletes the ones nothing points at and keeps the one a bottle still holds', async () => {
      const ctx = ctxFor(BEN);
      await entry.purge(ctx);
      await entry.postPurge(ctx);

      expect(await reload(empty)).toBeNull();
      expect(await reload(benWine)).toBeNull();
      const kept = await reload(held);
      expect(kept).toMatchObject({ uncheckedIdentity: true, pendingIdentity: true });
      expect(String(kept.createdBy)).toBe(String(DELETED));
    });
  });
});
