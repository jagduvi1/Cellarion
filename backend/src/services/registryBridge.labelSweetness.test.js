/**
 * Adopting a registry wine and its label sweetness term (GitHub discussion
 * #1754), the client side of protocol v2.
 *
 * WHY THIS TEST EXISTS:
 * The registry sends the term by WORD and scale, never by id — ids differ per
 * server — so the copy resolves it against THIS install's term table. Only
 * when the registry says something (the key is present): an older registry
 * sends none, and that must not clear a term held here. A word this table
 * lacks is never minted from the wire: it stays in the name, where every
 * reader still finds it, and the row is marked for a curator. The dedup key
 * carries the resolved term, so a later local add finds the copy. Same mocks
 * as registryBridge.test.
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
const registryWine = (over = {}) => ({
  id: RID, slug: 'keller-riesling-spatlese', producer: 'Weingut Keller', name: 'Riesling Spätlese', type: 'white', appellation: 'Rheinhessen', classification: null,
  region: 'Rheinhessen', country: 'Germany', grapes: ['Riesling'], image: null, imageCredit: null, lwin: null,
  profile: null, windows: [], values: [],
  ...over,
});
const lookup = (doc) => ({ populate: jest.fn().mockResolvedValue(doc), then: (res, rej) => Promise.resolve(doc).then(res, rej) });

beforeEach(() => {
  jest.clearAllMocks();
  bridge._reset();
  client.isEnabled.mockReturnValue(true);
  WineDefinition.findOne.mockReturnValue(lookup(null));
  RegistryDataKey.findOne.mockResolvedValue(null);
  WineVintageProfile.findOne.mockResolvedValue(null);
  RegistryDataValue.findOne.mockResolvedValue(null);
  SiteConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  // This install's term table: the German word on both scales.
  ops.primeSweetnessCache([
    { _id: 'sw-trocken', name: 'Trocken', scale: 'still', band: 'dry', country: null, synonyms: [] },
    { _id: 'sw-trocken-sekt', name: 'Trocken', scale: 'sparkling', band: 'sec', country: null, synonyms: [] },
  ]);
});
afterEach(() => ops.primeSweetnessCache(null));

const adopted = () => WineDefinition.mock.calls[0][0];

test('a registry that says nothing about sweetness (no key) sets nothing and keys the copy as before', async () => {
  client.fetchWine.mockResolvedValue(registryWine());
  await bridge.adoptWine(RID, USER);
  expect(adopted()).not.toHaveProperty('labelSweetness');
  expect(adopted()).not.toHaveProperty('sweetnessReview');
  expect(adopted().normalizedKey).toBe(generateWineKey('Riesling Spätlese', 'Weingut Keller', 'Rheinhessen'));
});

test('a term the registry sends resolves by word and scale to THIS table\'s row; the key carries the word', async () => {
  client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'Trocken', scale: 'still', band: 'dry', regulated: true } }));
  await bridge.adoptWine(RID, USER);
  expect(adopted()).toMatchObject({ name: 'Riesling Spätlese', labelSweetness: 'sw-trocken' });
  const key = generateWineKey('Riesling Spätlese', 'Weingut Keller', 'Rheinhessen', { sweetness: 'Trocken' });
  expect(adopted().normalizedKey).toBe(key);
  expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: key });
});

test('the same word on a Sekt resolves on the sparkling scale (the type decides when the registry sends only the word)', async () => {
  client.fetchWine.mockResolvedValue(registryWine({ type: 'sparkling', labelSweetness: 'Trocken' }));
  await bridge.adoptWine(RID, USER);
  expect(adopted().labelSweetness).toBe('sw-trocken-sekt');
});

test('a word this table lacks is never minted: it stays in the name, the row is marked for a curator, the key carries no suffix', async () => {
  client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'Halbsüß', scale: 'still', band: 'medium-sweet' } }));
  await bridge.adoptWine(RID, USER);
  expect(adopted()).toMatchObject({ name: 'Riesling Spätlese Halbsüß', labelSweetness: null });
  expect(adopted().sweetnessReview).toMatchObject({ reason: 'unknown_term', detail: expect.stringContaining('Halbsüß') });
  expect(adopted().normalizedKey).toBe(generateWineKey('Riesling Spätlese', 'Weingut Keller', 'Rheinhessen'));
});

test('an explicit null is a statement: the copy records none', async () => {
  client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: null }));
  await bridge.adoptWine(RID, USER);
  expect(adopted()).toHaveProperty('labelSweetness', null);
  expect(adopted()).not.toHaveProperty('sweetnessReview');
});
