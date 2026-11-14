/**
 * The pre-validate hook's CHAMPAGNE rule (docs/wine-fields.md): Premier Cru
 * and Grand Cru rate the village, so a cru form set as the appellation is
 * stored as "Champagne" on any save-based write, the cru joins the tiers the
 * wine already carries, and the canonical key derived in the same save is the
 * key of the wine stored without the cru. No DB needed: doc.validate() runs
 * the middleware, against a taxonomy held in memory.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const { primeClassificationCache } = require('../services/classificationOps');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const oid = () => new mongoose.Types.ObjectId();
const FRANCE = oid();
const ROWS = [
  { _id: oid(), name: 'Grand Cru', kind: 'vineyard_rank', country: FRANCE, synonyms: [] },
  { _id: oid(), name: 'Premier Cru', kind: 'vineyard_rank', country: FRANCE, synonyms: ['1er Cru'] },
  { _id: oid(), name: 'Old Vines', kind: 'other', country: null, synonyms: ['Vieilles Vignes'] },
];
const rowId = (name) => ROWS.find((r) => r.name === name)._id;
const ids = (doc) => (doc.classifications || []).map(String);

const newWine = (overrides = {}) => new WineDefinition({
  name: 'Blanc de Blancs',
  producer: 'Maison Exemple',
  appellation: 'Champagne',
  country: FRANCE,
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  type: 'sparkling',
  ...overrides,
});

/** A doc as a later save sees it: not new, nothing modified yet. */
const savedWine = async (overrides = {}) => {
  const doc = newWine(overrides);
  await doc.validate();
  doc.$isNew = false;
  for (const path of Object.keys(doc.toObject())) doc.unmarkModified(path);
  return doc;
};

describe('with the classification taxonomy loaded', () => {
  beforeEach(() => primeClassificationCache(ROWS));
  afterEach(() => primeClassificationCache(null));

  test.each([
    ['Champagne Grand Cru', 'Grand Cru'],
    ['Champagne Premier Cru', 'Premier Cru'],
    ['Champagne 1er Cru', 'Premier Cru'],
    ['champagne  grand  cru', 'Grand Cru'],
  ])('a new wine typed with %s stores Champagne and the tier %s', async (appellation, tier) => {
    const doc = newWine({ appellation });
    await doc.validate();
    expect(doc.appellation).toBe('Champagne');
    expect(doc.classification).toBe(tier);
    expect(ids(doc)).toEqual([String(rowId(tier))]);
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Blanc de Blancs', 'Maison Exemple', 'Champagne'));
  });

  test('the cru is added to a tier the wine was created with, never instead of it', async () => {
    const doc = newWine({ appellation: 'Champagne Premier Cru', classification: 'Old Vines', classifications: [rowId('Old Vines')] });
    await doc.validate();
    expect(doc.appellation).toBe('Champagne');
    expect(doc.classification).toBe('Premier Cru, Old Vines');
    expect(ids(doc)).toEqual([String(rowId('Premier Cru')), String(rowId('Old Vines'))]);
  });

  test('a later edit to a cru form keeps the tier the wine already had', async () => {
    const doc = await savedWine({ classification: 'Old Vines', classifications: [rowId('Old Vines')] });
    doc.appellation = 'Champagne Grand Cru';
    await doc.validate();
    expect(doc.appellation).toBe('Champagne');
    expect(doc.classification).toBe('Grand Cru, Old Vines');
    expect(ids(doc)).toEqual([String(rowId('Grand Cru')), String(rowId('Old Vines'))]);
  });

  test('a wine that already carries the cru gets it once', async () => {
    const doc = await savedWine({ classification: 'Grand Cru', classifications: [rowId('Grand Cru')] });
    doc.appellation = 'Champagne Grand Cru';
    await doc.validate();
    expect(doc.classification).toBe('Grand Cru');
    expect(ids(doc)).toEqual([String(rowId('Grand Cru'))]);
  });

  test('a wine that holds only text keeps a word the list lacks out of the way, and gains the tier', async () => {
    const doc = newWine({ appellation: 'Champagne Grand Cru', classification: 'Vieilles Vignes' });
    await doc.validate();
    expect(doc.classification).toBe('Grand Cru, Old Vines');
  });

  test('Cognac, the other appellations of Champagne and a named village are stored as typed, with no tier', async () => {
    for (const appellation of ['Champagne', 'Grande Champagne', 'Petite Champagne', 'Fine Champagne', 'Ratafia de Champagne', 'Coteaux Champenois', 'Rosé des Riceys', 'Champagne Grand Cru (Bouzy)']) {
      const doc = newWine({ appellation });
      await doc.validate();
      expect(doc.appellation).toBe(appellation);
      expect(doc.classification == null).toBe(true);
      expect(ids(doc)).toEqual([]);
    }
  });

  test('a row stored with a cru form is left as it is by a save that does not touch the appellation', async () => {
    const doc = await savedWine();
    // As a row written before the rule reads: set and marked clean.
    doc.appellation = 'Champagne Grand Cru';
    doc.unmarkModified('appellation');
    doc.imageCredit = 'Example credit';
    await doc.validate();
    expect(doc.appellation).toBe('Champagne Grand Cru');
    expect(doc.classification == null).toBe(true);
  });
});

describe('with no taxonomy loaded (no connection, no seed)', () => {
  beforeEach(() => primeClassificationCache(null));

  test('the cru is kept as text beside the text the wine had', async () => {
    const doc = newWine({ appellation: 'Champagne 1er Cru', classification: 'Vieilles Vignes' });
    await doc.validate();
    expect(doc.appellation).toBe('Champagne');
    expect(doc.classification).toBe('Vieilles Vignes, Premier Cru');
    const bare = newWine({ appellation: 'Champagne Grand Cru' });
    await bare.validate();
    expect(bare.appellation).toBe('Champagne');
    expect(bare.classification).toBe('Grand Cru');
  });
});
