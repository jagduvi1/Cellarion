/**
 * The mint and a Champagne cru typed into the appellation
 * (docs/wine-fields.md).
 *
 * WHY THIS TEST EXISTS:
 * A wine's identity key is producer:name:appellation. "Champagne Grand Cru"
 * and "Champagne" keyed apart, so an add typed with the cru missed the wine
 * stored without it and minted a twin the duplicate guard never saw. The mint
 * now splits the value before any stage runs: it looks the wine up under
 * "Champagne", and a wine it does create is stored as "Champagne" with the cru
 * among its tiers. Cognac's "Grande Champagne" and a value that names a
 * village are other things and go through as typed. Same mocks as
 * findOrCreateWine.test; the write rule and the taxonomy (in memory) are real.
 */
jest.mock('../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.aggregate = jest.fn();
  return ctor;
});
jest.mock('../models/Country', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Region', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Grape', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  return ctor;
});
jest.mock('../models/Appellation', () => ({ exists: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('./search', () => ({ getIsAvailable: jest.fn(), search: jest.fn(), indexWine: jest.fn() }));
jest.mock('./wineMatching', () => ({ scoreAllMatches: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn().mockResolvedValue(null) }));
jest.mock('./producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (producer) => producer) }));

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const searchService = require('./search');
const { findOrCreateWine } = require('./findOrCreateWine');
const { primeClassificationCache } = require('./classificationOps');
const { generateWineKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const USER_ID = 'user-1';
const FRANCE = 'country-fr';
const ROWS = [
  { _id: 'gc', name: 'Grand Cru', kind: 'vineyard_rank', country: FRANCE, synonyms: [] },
  { _id: 'pc', name: 'Premier Cru', kind: 'vineyard_rank', country: FRANCE, synonyms: ['1er Cru'] },
  { _id: 'ov', name: 'Old Vines', kind: 'other', country: null, synonyms: ['Vieilles Vignes'] },
];
const wine = (over = {}) => ({ name: 'Clos du Mesnil', producer: 'Maison Exemple', country: 'France', region: 'Champagne', type: 'sparkling', grapes: [], ...over });

const chain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
};

let warnSpy; let logSpy;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  primeClassificationCache(ROWS);
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  WineDefinition.find.mockImplementation(() => chain([]));
  WineDefinition.aggregate.mockResolvedValue([]);
  for (const Model of [Appellation, Region, Country, Grape]) Model.find.mockImplementation(() => chain([]));
  searchService.getIsAvailable.mockReturnValue(false);
  Country.findOne.mockResolvedValue({ _id: FRANCE, name: 'France' });
  Region.findOne.mockResolvedValue({ _id: 'region-champagne' });
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
});
afterEach(() => { warnSpy.mockRestore(); logSpy.mockRestore(); primeClassificationCache(null); });

const CHAMPAGNE_KEY = generateWineKey('Clos du Mesnil', 'Maison Exemple', 'Champagne');

describe('an add typed with a cru form finds the wine stored as Champagne', () => {
  test.each(['Champagne Grand Cru', 'Champagne Premier Cru', 'Champagne 1er Cru', 'champagne  grand cru'])('%s looks the wine up under the Champagne key and mints nothing', async (appellation) => {
    const existing = { _id: 'wine-existing', name: 'Clos du Mesnil', producer: 'Maison Exemple', appellation: 'Champagne' };
    WineDefinition.findOne.mockImplementation((q) => ({ populate: jest.fn().mockResolvedValue(q.normalizedKey === CHAMPAGNE_KEY ? existing : null) }));
    const result = await findOrCreateWine(wine({ appellation }), USER_ID);
    expect(result).toEqual({ wine: existing, created: false });
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: 'maison exemple:clos du mesnil:champagne' });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('the canonical lookup asks for the Champagne identity too', async () => {
    await findOrCreateWine(wine({ appellation: 'Champagne Grand Cru' }), USER_ID, { matchOnly: true });
    const canonical = WineDefinition.find.mock.calls.map(([q]) => q.canonicalKey).filter((k) => typeof k === 'string');
    expect(canonical).toEqual([computeCanonicalKey('Clos du Mesnil', 'Maison Exemple', 'Champagne')]);
  });

  test('the curated spelling the resolver hands back is split as well', async () => {
    Appellation.find.mockImplementation((q) => chain(
      q.$or && q.$or.some((c) => c.normalizedName === 'champagne grand cru') ? [{ name: 'Champagne Grand Cru' }] : []
    ));
    const result = await findOrCreateWine(wine({ appellation: 'champagne grand cru' }), USER_ID, { confirmCreate: true });
    expect(result.created).toBe(true);
    expect(result.wine.appellation).toBe('Champagne');
  });
});

describe('a wine the mint creates', () => {
  test('is stored as Champagne with the cru as its tier, under the Champagne key', async () => {
    const result = await findOrCreateWine(wine({ appellation: 'Champagne Grand Cru' }), USER_ID, { confirmCreate: true });
    expect(result.created).toBe(true);
    expect(result.wine).toMatchObject({
      appellation: 'Champagne', classification: 'Grand Cru', classifications: ['gc'], normalizedKey: CHAMPAGNE_KEY,
    });
  });

  test('keeps the tier it was given beside the cru', async () => {
    const result = await findOrCreateWine(wine({ appellation: 'Champagne 1er Cru', classification: 'Vieilles Vignes' }), USER_ID, { confirmCreate: true });
    expect(result.wine).toMatchObject({ appellation: 'Champagne', classification: 'Premier Cru, Old Vines', classifications: ['pc', 'ov'] });
  });

  test('takes its region from the appellation Champagne, not from the typed cru form', async () => {
    const champagneRegion = { _id: 'region-champagne' };
    Region.find.mockImplementation((q) => chain(q.$or && q.$or.some((c) => c.normalizedName === 'champagne') ? [champagneRegion] : []));
    const result = await findOrCreateWine(wine({ appellation: 'Champagne Grand Cru', region: 'Reims' }), USER_ID, { confirmCreate: true });
    expect(result.wine.region).toBe('region-champagne');
    expect(Region.findOne).not.toHaveBeenCalled();
  });

  test('records the tier under the appellation\'s provenance when the caller stated no classification', async () => {
    const provenance = { name: 'model', producer: 'model', appellation: 'file', classification: 'model' };
    const fromFile = await findOrCreateWine(wine({ appellation: 'Champagne Grand Cru' }), USER_ID, { confirmCreate: true, provenance });
    expect(fromFile.wine.identityProvenance).toMatchObject({ appellation: 'file', classification: 'file' });
    const stated = await findOrCreateWine(wine({ appellation: 'Champagne Grand Cru', classification: 'Old Vines' }), USER_ID, { confirmCreate: true, provenance });
    expect(stated.wine.identityProvenance).toMatchObject({ appellation: 'file', classification: 'model' });
  });
});

describe('what is not a Champagne cru form goes through as typed', () => {
  test.each([
    ['Grande Champagne', 'maison exemple:clos du mesnil:grande champagne'],
    ['Petite Champagne', 'maison exemple:clos du mesnil:petite champagne'],
    ['Fine Champagne', 'maison exemple:clos du mesnil:fine champagne'],
    ['Champagne Grand Cru (Bouzy)', 'maison exemple:clos du mesnil:champagne grand cru bouzy'],
    ['Champagne', 'maison exemple:clos du mesnil:champagne'],
  ])('%s', async (appellation, key) => {
    const result = await findOrCreateWine(wine({ appellation }), USER_ID, { confirmCreate: true });
    expect(result.wine).toMatchObject({ appellation, normalizedKey: key, classification: null });
    expect(result.wine.classifications).toEqual([]);
  });
});
