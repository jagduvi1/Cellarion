/**
 * Adopting a registry wine and its label sweetness term (GitHub discussion
 * #1754), the client side of protocol v2.
 *
 * WHY THIS TEST EXISTS:
 * The registry sends the term by WORD (and the scale that disambiguates it),
 * never by id — ids differ per server — so the copy resolves it against THIS
 * install's term table. Only when the registry says something (the key is
 * present): an older registry sends none, and that must not clear a term
 * held here. A word this table lacks is never minted from the wire: it stays
 * in the name, where every reader still finds it, the row is marked for a
 * curator — once, at the first arrival — and the dedup key is built from the
 * name as STORED, so a later plain add cannot exact-match the sweet wine at
 * the one stage where no guard runs. A copy typed before the Bridge carried
 * terms (the word in its name, no term) is found and linked, not twinned.
 * Same mocks as registryBridge.test.
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
const key = (name, sweetness = null) => generateWineKey(name, 'Weingut Keller', 'Rheinhessen', { sweetness });

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
    { _id: 'sw-trocken', name: 'trocken', scale: 'still', band: 'dry', country: null, synonyms: [] },
    { _id: 'sw-trocken-sekt', name: 'Trocken', scale: 'sparkling', band: 'sec', country: null, synonyms: [] },
  ]);
});
afterEach(() => ops.primeSweetnessCache(null));

const adopted = () => WineDefinition.mock.calls[0][0];

describe('adoptWine', () => {
  test('a registry that says nothing about sweetness (no key) sets nothing and keys the copy as before', async () => {
    client.fetchWine.mockResolvedValue(registryWine());
    await bridge.adoptWine(RID, USER);
    expect(adopted()).not.toHaveProperty('labelSweetness');
    expect(adopted()).not.toHaveProperty('sweetnessReview');
    expect(adopted().normalizedKey).toBe(key('Riesling Spätlese'));
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: key('Riesling Spätlese') });
  });

  test('a term the registry sends resolves by word and scale to THIS table\'s row; the key carries the word; the exact key is probed first, the display-name key only when it misses', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'trocken', scale: 'still', band: 'dry', regulated: true } }));
    await bridge.adoptWine(RID, USER);
    expect(adopted()).toMatchObject({ name: 'Riesling Spätlese', labelSweetness: 'sw-trocken' });
    expect(adopted().normalizedKey).toBe(key('Riesling Spätlese', 'trocken'));
    const probes = WineDefinition.findOne.mock.calls.map((c) => c[0]).filter((q) => q.normalizedKey);
    expect(probes).toEqual([{ normalizedKey: key('Riesling Spätlese', 'trocken') }, { normalizedKey: key('Riesling Spätlese trocken') }]);
  });

  test('an exact-key hit is taken without probing the display-name key', async () => {
    const exact = { _id: 'ex1', name: 'Riesling Spätlese', registrySyncedAt: null, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne
      .mockReturnValueOnce(lookup(null))   // by registryId
      .mockReturnValueOnce(lookup(exact)); // the exact key
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'trocken', scale: 'still', band: 'dry' } }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.wine).toBe(exact);
    expect(WineDefinition.findOne).toHaveBeenCalledTimes(2);
  });

  test('a local copy typed before the Bridge carried terms — the word in its name, no term — is linked, not twinned', async () => {
    const local = { _id: 'old1', name: 'Riesling Spätlese trocken', registrySyncedAt: null, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne
      .mockReturnValueOnce(lookup(null))   // by registryId: not held yet
      .mockReturnValueOnce(lookup(null))   // the exact key: nothing
      .mockReturnValueOnce(lookup(local)); // the display-name key
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'trocken', scale: 'still', band: 'dry' } }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.created).toBe(true);
    expect(r.wine).toBe(local);
    expect(local.registryId).toBe(RID);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('a row already linked to a DIFFERENT registry wine is never re-pointed: conflict, nothing written', async () => {
    const other = { _id: 'x1', name: 'Riesling Spätlese', registryId: 'c'.repeat(24), save: jest.fn(), populate: jest.fn() };
    WineDefinition.findOne.mockReturnValueOnce(lookup(null)).mockReturnValueOnce(lookup(other));
    client.fetchWine.mockResolvedValue(registryWine());
    expect(await bridge.adoptWine(RID, USER)).toEqual({ ok: false, code: 'conflict' });
    expect(other.save).not.toHaveBeenCalled();
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('the same word on a Sekt resolves on the sparkling scale (the type decides when the registry sends only the word)', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ type: 'sparkling', labelSweetness: 'Trocken' }));
    await bridge.adoptWine(RID, USER);
    expect(adopted().labelSweetness).toBe('sw-trocken-sekt');
  });

  test('a word this table lacks is never minted: it stays in the name, the row is marked for a curator, and the key is built from the STORED name', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'halbsüß', scale: 'still', band: 'medium-sweet' } }));
    await bridge.adoptWine(RID, USER);
    expect(adopted()).toMatchObject({ name: 'Riesling Spätlese halbsüß', labelSweetness: null });
    expect(adopted().sweetnessReview).toMatchObject({ reason: 'unknown_term', detail: expect.stringContaining('halbsüß') });
    expect(adopted().normalizedKey).toBe(key('Riesling Spätlese halbsüß'));
    // A later plain "Riesling Spätlese" therefore misses at the exact-key stage.
    expect(adopted().normalizedKey).not.toBe(key('Riesling Spätlese'));
  });

  test('an explicit null is a statement: the copy records none', async () => {
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: null }));
    await bridge.adoptWine(RID, USER);
    expect(adopted()).toHaveProperty('labelSweetness', null);
    expect(adopted()).not.toHaveProperty('sweetnessReview');
  });
});

describe('refreshHeld — the hourly sync of a copy', () => {
  const held = () => WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'l1', registryId: RID, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), createdBy: USER }]) }) });

  test('a refresh that meets the same unknown word keeps the marker it set — since is the FIRST arrival — and keys from the stored name', async () => {
    held();
    client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: 'x' }], removed: [], checked: 1, failed: false });
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'halbsüß', scale: 'still', band: 'medium-sweet' } }));
    const since = new Date('2026-08-01');
    const local = {
      _id: 'l1', name: 'Riesling Spätlese halbsüß', createdBy: USER, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'),
      sweetnessReview: { reason: 'unknown_term', detail: 'The registry states "halbsüß", a sweetness term this server\'s table does not have', since },
      aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined),
    };
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.sweetnessReview.since).toBe(since);
    expect(local.name).toBe('Riesling Spätlese halbsüß');
    expect(local.normalizedKey).toBe(key('Riesling Spätlese halbsüß'));
    expect(local.save).toHaveBeenCalled();
  });

  test('a refresh that meets a DIFFERENT unknown word keeps since but refreshes the detail', async () => {
    held();
    client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: 'x' }], removed: [], checked: 1, failed: false });
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'lieblich', scale: 'still', band: 'medium-sweet' } }));
    const since = new Date('2026-08-01');
    const local = {
      _id: 'l1', name: 'Riesling Spätlese halbsüß', createdBy: USER, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'),
      sweetnessReview: { reason: 'unknown_term', detail: 'The registry states "halbsüß", a sweetness term this server\'s table does not have', since },
      aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined),
    };
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.sweetnessReview.since).toBe(since);
    expect(local.sweetnessReview.detail).toMatch(/"lieblich"/);
    expect(local.name).toBe('Riesling Spätlese lieblich');
  });

  test('a refresh that brings a term the table knows sets it and the key', async () => {
    held();
    client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: 'x' }], removed: [], checked: 1, failed: false });
    client.fetchWine.mockResolvedValue(registryWine({ labelSweetness: { name: 'trocken', scale: 'still', band: 'dry' } }));
    const local = { _id: 'l1', name: 'Riesling Spätlese', createdBy: USER, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.labelSweetness).toBe('sw-trocken');
    expect(local.normalizedKey).toBe(key('Riesling Spätlese', 'trocken'));
  });
});
