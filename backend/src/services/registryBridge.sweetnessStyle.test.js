/**
 * Adopting and refreshing a registry wine's sweetness style — the client side
 * of protocol v2.
 *
 * WHY THIS TEST EXISTS:
 * The style is the term a wine is known by when its label states none, named
 * by the producer or the trade. It is descriptive, so it never rides in the
 * identity a copy is built and keyed from. It arrives by WORD and is matched
 * on THIS install's term table — a word the table lacks is ignored, never
 * minted. It goes through the write rule (services/sweetnessWrite), so a
 * style this install holds yields only to a stronger source, a merchant never
 * sets a legal term, and only the key's presence says anything: an older
 * registry sends none, and that must not clear a style held here. A null
 * clears only a copy nobody edited here. Same mocks as
 * registryBridge.labelSweetness.test.
 */
jest.mock('../models/WineDefinition', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = this._id || 'new1';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  M.findOne = jest.fn(); M.find = jest.fn(); M.findById = jest.fn(); M.countDocuments = jest.fn(); M.updateOne = jest.fn();
  return M;
});
jest.mock('../models/WineVintageProfile', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}), findOne: jest.fn() }));
jest.mock('../models/RegistryDataKey', () => ({ findOne: jest.fn(), create: jest.fn(), findById: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}), findOne: jest.fn() }));
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  fetchWine: jest.fn(), search: jest.fn(), changes: jest.fn(), me: jest.fn(),
  forwardCorrection: jest.fn().mockResolvedValue({ ok: true }), forwardValue: jest.fn().mockResolvedValue({ ok: true }), forwardRequest: jest.fn().mockResolvedValue({ ok: true }),
  transportState: jest.fn(() => ({ enabled: true, reason: null, url: 'https://cellarion.app', keyPrefix: 'cbr_12345678', blocked: null, lastError: null })),
}));
jest.mock('./findOrCreateWine', () => ({
  findOrCreateCountry: jest.fn(async (name) => ({ _id: `country:${name}` })),
  findOrCreateRegion: jest.fn(async (name) => ({ _id: `region:${name}` })),
  regionForAppellation: jest.fn(async () => null),
  findOrCreateGrapes: jest.fn(async (names) => names.map((n) => `grape:${n}`)),
}));
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const SiteConfig = require('../models/SiteConfig');
const client = require('./registryBridgeClient');
const { generateWineKey } = require('../utils/normalize');
const ops = require('./sweetnessOps');
const bridge = require('./registryBridge');

const RID = 'a'.repeat(24);
const USER = 'u1';
const TRADE_URL = 'https://merchant.example/riesling-kabinett';
const PRODUCER_URL = 'https://weingut-beispiel.example/weine/kabinett';
const registryWine = (over = {}) => ({
  id: RID, slug: 'weingut-beispiel-riesling-kabinett', producer: 'Weingut Beispiel', name: 'Riesling Kabinett', type: 'white', appellation: 'Mosel', classification: null,
  region: 'Mosel', country: 'Germany', grapes: ['Riesling'], image: null, imageCredit: null, lwin: null,
  profile: null, windows: [], values: [],
  ...over,
});
const wireStyle = (over = {}) => ({ name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: TRADE_URL, ...over });
const lookup = (doc) => ({ populate: jest.fn().mockResolvedValue(doc), then: (res, rej) => Promise.resolve(doc).then(res, rej) });
const KEY = generateWineKey('Riesling Kabinett', 'Weingut Beispiel', 'Mosel');

beforeEach(() => {
  jest.clearAllMocks();
  bridge._reset();
  client.isEnabled.mockReturnValue(true);
  WineDefinition.findOne.mockReturnValue(lookup(null));
  RegistryDataKey.findOne.mockResolvedValue(null);
  WineVintageProfile.findOne.mockResolvedValue(null);
  RegistryDataValue.findOne.mockResolvedValue(null);
  SiteConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  // This install's term table.
  ops.primeSweetnessCache([
    { _id: 'sw-feinherb', name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] },
    { _id: 'sw-fruchtsuss', name: 'fruchtsüß', scale: 'still', band: 'medium-sweet', regulated: false, country: null, synonyms: [] },
    { _id: 'sw-trocken', name: 'trocken', scale: 'still', band: 'dry', country: null, synonyms: [] },
  ]);
});
afterEach(() => ops.primeSweetnessCache(null));

const adoptedArg = () => WineDefinition.mock.calls[0][0];

describe('adoptWine', () => {
  test('a registry that says nothing about a style (an older one: no key) sets none', async () => {
    client.fetchWine.mockResolvedValue(registryWine());
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine.sweetnessStyle).toBeUndefined();
    expect(adoptedArg()).not.toHaveProperty('sweetnessStyle');
  });

  test('a style the registry sends is matched by word on this table and stored with its source and link — outside the identity, the key unchanged', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: wireStyle() }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine.sweetnessStyle).toEqual({ term: 'sw-feinherb', source: 'trade', url: TRADE_URL });
    expect(adoptedArg()).not.toHaveProperty('sweetnessStyle');
    expect(adoptedArg().normalizedKey).toBe(KEY);
    expect(adoptedArg().name).toBe('Riesling Kabinett');
    expect(r.wine.save).toHaveBeenCalled();
  });

  test('a word this table lacks is ignored, never minted and never marked', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: wireStyle({ name: 'restsüß' }) }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine.sweetnessStyle).toBeUndefined();
    expect(r.wine.sweetnessReview).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  test('the write rule holds on the wire too: a legal term from the trade is not stored', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: wireStyle({ name: 'trocken', regulated: true }) }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine.sweetnessStyle).toBeUndefined();
  });

  test('a style beside the label\'s own term that disagrees is held and marked, the term kept', async () => {
    client.fetchWine.mockResolvedValue(registryWine({
      labelSweetness: { name: 'trocken', scale: 'still', band: 'dry', regulated: true }, sweetnessStyle: wireStyle(),
    }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine.labelSweetness).toBe('sw-trocken');
    expect(r.wine.sweetnessStyle).toBeUndefined();
    expect(r.wine.sweetnessReview).toMatchObject({ reason: 'term_contradiction' });
  });

  test('a local wine typed before the Bridge keeps its own producer style; the registry\'s trade word does not replace it', async () => {
    const own = { term: 'sw-fruchtsuss', source: 'producer', url: PRODUCER_URL };
    const local = { _id: 'old1', name: 'Riesling Kabinett', labelSweetness: null, sweetnessStyle: { ...own }, registrySyncedAt: null, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne
      .mockReturnValueOnce(lookup(null))    // by registryId: not held yet
      .mockReturnValueOnce(lookup(local));  // the key: the local row
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: wireStyle() }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine).toBe(local);
    expect(local.sweetnessStyle).toEqual(own);
    expect(local.save).toHaveBeenCalled();
  });

  test('...and an explicit null from the registry does not clear it', async () => {
    const own = { term: 'sw-fruchtsuss', source: 'producer', url: PRODUCER_URL };
    const local = { _id: 'old1', name: 'Riesling Kabinett', labelSweetness: null, sweetnessStyle: { ...own }, registrySyncedAt: null, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne.mockReturnValueOnce(lookup(null)).mockReturnValueOnce(lookup(local));
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: null }));
    await bridge.adoptWine(RID, USER);
    expect(local.sweetnessStyle).toEqual(own);
  });
});

describe('refreshHeld — the hourly sync of a copy', () => {
  const synced = new Date('2026-09-01');
  const held = () => WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'l1', registryId: RID, registrySyncedAt: synced, updatedAt: synced, createdBy: USER }]) }) });
  const changed = () => client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: 'x' }], removed: [], checked: 1, failed: false });
  const copy = (over = {}) => ({
    _id: 'l1', name: 'Riesling Kabinett', createdBy: USER, registrySyncedAt: synced, updatedAt: synced,
    labelSweetness: null, sweetnessStyle: null, aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined), ...over,
  });

  test('a style the registry now names is filled in', async () => {
    held(); changed();
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: wireStyle() }));
    const local = copy();
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.sweetnessStyle).toEqual({ term: 'sw-feinherb', source: 'trade', url: TRADE_URL });
    expect(local.save).toHaveBeenCalled();
  });

  test('no key: the style held here stays', async () => {
    held(); changed();
    client.fetchWine.mockResolvedValue(registryWine());
    const local = copy({ sweetnessStyle: { term: 'sw-feinherb', source: 'trade', url: TRADE_URL } });
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.sweetnessStyle).toEqual({ term: 'sw-feinherb', source: 'trade', url: TRADE_URL });
  });

  test('a null clears the style of a copy nobody edited here, and of no other', async () => {
    held(); changed();
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: null }));
    const untouched = copy({ sweetnessStyle: { term: 'sw-feinherb', source: 'trade', url: TRADE_URL } });
    WineDefinition.findById.mockResolvedValue(untouched);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(untouched.sweetnessStyle).toBeNull();

    jest.clearAllMocks();
    bridge._reset();
    held(); changed();
    SiteConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    client.isEnabled.mockReturnValue(true);
    client.fetchWine.mockResolvedValue(registryWine({ sweetnessStyle: null }));
    const edited = copy({ updatedAt: new Date('2026-09-05'), sweetnessStyle: { term: 'sw-feinherb', source: 'trade', url: TRADE_URL } });
    WineDefinition.findById.mockResolvedValue(edited);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(edited.sweetnessStyle).toEqual({ term: 'sw-feinherb', source: 'trade', url: TRADE_URL });
  });
});
