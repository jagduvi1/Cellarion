/**
 * A Registry Bridge copy's sweetness style on a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * The style path is select: false, so the Bridge must ask for it when it
 * loads a copy to adopt or refresh; the write rule refuses a document loaded
 * without it (not_loaded), and then a registry style never arrives on any
 * copy. The mocked Bridge suite cannot show that a real query loads the field:
 * this one adopts and refreshes a copy through real models and checks what is
 * stored. Only the transport to the registry is a stand-in.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_bridgestyle`, dropped before and after. Skipped without it.
 */
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  fetchWine: jest.fn(), search: jest.fn(), changes: jest.fn(), me: jest.fn(),
  forwardCorrection: jest.fn(), forwardValue: jest.fn(), forwardRequest: jest.fn(),
  transportState: jest.fn(() => ({ enabled: true, reason: null })),
}));
// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined), removeWine: jest.fn() }));
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));

const mongoose = require('mongoose');
const client = require('./registryBridgeClient');
const bridge = require('./registryBridge');
const ops = require('./sweetnessOps');
const WineDefinition = require('../models/WineDefinition');
const SweetnessTerm = require('../models/SweetnessTerm');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_bridgestyle'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/registryBridge.sweetnessStyle.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const PRODUCER_URL = 'https://weingut-beispiel.example/weine/kabinett';
const USER = new mongoose.Types.ObjectId();
const registryWine = (id, over = {}) => ({
  id, slug: `weingut-beispiel-riesling-${id.slice(-4)}`, producer: 'Weingut Beispiel', name: `Riesling ${id.slice(-4)}`, type: 'white', appellation: 'Mosel', classification: null,
  region: 'Mosel', country: 'Germany', grapes: ['Riesling'], image: null, imageCredit: null, lwin: null,
  profile: null, windows: [], values: [],
  ...over,
});
const wireStyle = { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'producer', sourceUrl: PRODUCER_URL };

describeWithMongo('a Bridge copy and its sweetness style (real MongoDB)', () => {
  let feinherb;

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    await ops.ensureSweetnessSeed();
    ops.primeSweetnessCache(null);
    feinherb = await SweetnessTerm.findOne({ name: 'feinherb', scale: 'still' }).lean();
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(() => { jest.clearAllMocks(); bridge._reset(); client.isEnabled.mockReturnValue(true); });

  const storedStyle = async (registryId) => {
    const raw = await mongoose.connection.db.collection('winedefinitions').findOne({ registryId });
    return raw && raw.sweetnessStyle;
  };

  test('an adopted copy stores the style the registry sends', async () => {
    const RID = 'a'.repeat(23) + '1';
    client.fetchWine.mockResolvedValue(registryWine(RID, { sweetnessStyle: wireStyle }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.ok).toBe(true);
    expect(await storedStyle(RID)).toEqual({ term: feinherb._id, source: 'producer', url: PRODUCER_URL });
  });

  test('a refresh loads the copy WITH its style, so the registry\'s style arrives', async () => {
    const RID = 'a'.repeat(23) + '2';
    client.fetchWine.mockResolvedValue(registryWine(RID));
    expect((await bridge.adoptWine(RID, USER)).ok).toBe(true);
    expect(await storedStyle(RID)).toBeUndefined();

    client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: new Date(Date.now() + 60000).toISOString() }], removed: [], checked: 1, checkedAt: new Date().toISOString() });
    client.fetchWine.mockResolvedValue(registryWine(RID, { sweetnessStyle: wireStyle }));
    const summary = await bridge.refreshHeld({ now: new Date() });
    expect(summary).toMatchObject({ failures: 0 });
    expect(await storedStyle(RID)).toEqual({ term: feinherb._id, source: 'producer', url: PRODUCER_URL });
    const copy = await WineDefinition.findOne({ registryId: RID }).select('+sweetnessStyle').lean();
    expect(copy.sweetnessReview == null).toBe(true);
  });
});
