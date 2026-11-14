/**
 * A Registry Bridge copy of a Champagne the registry sends with the cru in
 * the appellation, on a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * An install copies wines from the shared registry as it finds them, and a
 * registry that has not moved its rows yet still sends "Champagne Grand Cru"
 * as the appellation. The copy must be stored like any wine written here:
 * appellation "Champagne", both keys ending in "champagne", the cru among
 * the tiers beside the ones the registry sent. And a wine this install
 * already holds as "Champagne" must be LINKED, not twinned, because the
 * adoption looks it up by the key. Only the transport to the registry is a
 * stand-in.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_bridgecru`, dropped before and after. Skipped without it.
 */
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  fetchWine: jest.fn(), search: jest.fn(), changes: jest.fn(), me: jest.fn(),
  forwardCorrection: jest.fn(), forwardValue: jest.fn(), forwardRequest: jest.fn(),
  transportState: jest.fn(() => ({ enabled: true, reason: null })),
}));
// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined), removeWine: jest.fn(), getIsAvailable: jest.fn(() => false) }));
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));

const mongoose = require('mongoose');
const client = require('./registryBridgeClient');
const bridge = require('./registryBridge');
const classificationOps = require('./classificationOps');
const WineDefinition = require('../models/WineDefinition');
const Classification = require('../models/Classification');
const Country = require('../models/Country');
const { generateWineKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_bridgecru'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/registryBridge.champagneCru.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');
jest.setTimeout(60000);

const USER = new mongoose.Types.ObjectId();
const rid = (n) => 'b'.repeat(23) + n;
const registryWine = (id, over = {}) => ({
  id, slug: `maison-exemple-${id.slice(-1)}`, producer: 'Maison Exemple', name: `Cuvée ${id.slice(-1)}`, type: 'sparkling',
  appellation: 'Champagne Grand Cru', classification: null, region: 'Champagne', country: 'France', grapes: [],
  image: null, imageCredit: null, lwin: null, profile: null, windows: [], values: [],
  ...over,
});

describeWithMongo('a Bridge copy of a Champagne sent with the cru in its appellation (real MongoDB)', () => {
  let france;

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    france = await Country.create({ name: 'France', normalizedName: 'france', createdBy: USER });
    await classificationOps.seedClassifications();
  }, 60000);

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 60000);

  beforeEach(() => { jest.clearAllMocks(); bridge._reset(); client.isEnabled.mockReturnValue(true); });

  const copy = (registryId) => mongoose.connection.db.collection('winedefinitions').findOne({ registryId });
  const tiersOf = async (w) => (await Classification.find({ _id: { $in: w.classifications || [] } }).select('name').lean()).map((r) => r.name).sort();

  test('an adopted copy is stored as Champagne with the cru as its tier', async () => {
    const w = registryWine(rid('1'));
    client.fetchWine.mockResolvedValue(w);
    expect(await bridge.adoptWine(w.id, USER)).toMatchObject({ ok: true, created: true });
    const stored = await copy(w.id);
    expect(stored.appellation).toBe('Champagne');
    expect(stored.normalizedKey).toBe(generateWineKey(w.name, w.producer, 'Champagne'));
    expect(stored.canonicalKey).toBe(computeCanonicalKey(w.name, w.producer, 'Champagne'));
    expect(await tiersOf(stored)).toEqual(['Grand Cru']);
    expect(stored.classification).toBe('Grand Cru');
  });

  test('the cru joins the tiers the registry sends', async () => {
    const w = registryWine(rid('2'), { appellation: 'Champagne 1er Cru', classification: 'Old Vines', classifications: [{ name: 'Old Vines', kind: 'other' }] });
    client.fetchWine.mockResolvedValue(w);
    expect((await bridge.adoptWine(w.id, USER)).ok).toBe(true);
    const stored = await copy(w.id);
    expect(stored.appellation).toBe('Champagne');
    expect(await tiersOf(stored)).toEqual(['Old Vines', 'Premier Cru']);
    expect(stored.classification).toBe('Premier Cru, Old Vines');
  });

  test('a wine this install holds as Champagne is linked, not twinned', async () => {
    const w = registryWine(rid('3'));
    const local = await new WineDefinition({
      name: w.name, producer: w.producer, country: france._id, appellation: 'Champagne', type: 'sparkling',
      normalizedKey: generateWineKey(w.name, w.producer, 'Champagne'), createdBy: USER,
    }).save();
    client.fetchWine.mockResolvedValue(w);
    const r = await bridge.adoptWine(w.id, USER);
    expect(r.ok).toBe(true);
    expect(String(r.wine._id)).toBe(String(local._id));
    expect(await WineDefinition.countDocuments({ producer: w.producer, name: w.name })).toBe(1);
    expect((await copy(w.id)).appellation).toBe('Champagne');
  });

  test('a refresh that brings the cru form again leaves the copy on Champagne, with the tier', async () => {
    const w = registryWine(rid('4'), { appellation: 'Champagne' });
    client.fetchWine.mockResolvedValue(w);
    expect((await bridge.adoptWine(w.id, USER)).ok).toBe(true);
    expect(await tiersOf(await copy(w.id))).toEqual([]);

    client.changes.mockResolvedValue({ changed: [{ id: w.id, updatedAt: new Date(Date.now() + 60000).toISOString() }], removed: [], checked: 1, checkedAt: new Date().toISOString() });
    client.fetchWine.mockResolvedValue({ ...w, appellation: 'Champagne Premier Cru' });
    expect(await bridge.refreshHeld({ now: new Date() })).toMatchObject({ failures: 0 });
    const stored = await copy(w.id);
    expect(stored.appellation).toBe('Champagne');
    expect(stored.normalizedKey).toBe(generateWineKey(w.name, w.producer, 'Champagne'));
    expect(stored.canonicalKey).toBe(computeCanonicalKey(w.name, w.producer, 'Champagne'));
    expect(await tiersOf(stored)).toEqual(['Premier Cru']);
  });

  test('Cognac and a named village arrive as the registry sends them', async () => {
    for (const [n, appellation, segment] of [['5', 'Grande Champagne', 'grande champagne'], ['6', 'Fine Champagne', 'fine champagne'], ['7', 'Champagne Grand Cru (Bouzy)', 'champagne grand cru bouzy']]) {
      const w = registryWine(rid(n), { appellation, region: 'Cognac', type: 'white' });
      client.fetchWine.mockResolvedValue(w);
      expect((await bridge.adoptWine(w.id, USER)).ok).toBe(true);
      const stored = await copy(w.id);
      expect(stored.appellation).toBe(appellation);
      expect(stored.normalizedKey.endsWith(`:${segment}`)).toBe(true);
      expect(stored.canonicalKey.endsWith(`:${segment}`)).toBe(true);
      expect(stored.classification == null).toBe(true);
      expect(stored.classifications || []).toEqual([]);
    }
  });
});
