// The guard itself is not under test here (it needs the Appellation
// taxonomy); its output is passed in.
jest.mock('../services/findOrCreateWine', () => ({ unpolluteEstateName: jest.fn() }));
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn() }));

const { buildFixUpdate } = require('./fix-classification-polluted-names');
const { computeCanonicalKey } = require('../utils/wineIdentity');
const { generateWineKey } = require('../utils/normalize');

// A row the guard renames: the appellation stood in the name slot, so the
// estate name takes its place and the appellation moves to its own field.
const row = {
  _id: 'w1',
  name: 'Margaux',
  producer: 'Château du Tertre',
  appellation: null,
  classification: null,
  normalizedKey: 'chateau du tertre:margaux:',
};
const out = {
  name: 'Château du Tertre',
  appellation: 'Margaux',
  classification: null,
  changed: 'appellation_as_name',
};
const newKey = generateWineKey(out.name, row.producer, out.appellation);

describe('fix-classification-polluted-names buildFixUpdate', () => {
  it('sets the canonicalKey of the new name and appellation, and moves updatedAt', () => {
    const update = buildFixUpdate(row, out, newKey);
    expect(update.$set.canonicalKey).toBe(computeCanonicalKey(out.name, row.producer, out.appellation));
    expect(update.$set.canonicalKey).not.toBe(computeCanonicalKey(row.name, row.producer, row.appellation));
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
  });

  it('clears the name-check and cross-field clearances with their timestamps', () => {
    const update = buildFixUpdate(row, out, newKey);
    expect(update.$unset).toEqual({ verifiedChecks: '', crossChecksCleared: '' });
    expect(update.$set.verifiedAt).toBeNull();
    expect(update.$set.crossChecksClearedAt).toBeNull();
  });

  it('writes the guard output and the normalizedKey it is given', () => {
    const update = buildFixUpdate(row, out, newKey);
    expect(update.$set).toMatchObject({
      name: 'Château du Tertre',
      appellation: 'Margaux',
      classification: null,
      normalizedKey: newKey,
    });
  });

  it('keys a classification-only rename on the estate name with no appellation', () => {
    const polluted = { ...row, name: 'Grand Cru Classé de Graves', producer: 'Château Pape Clément', appellation: '' };
    const shifted = {
      name: 'Château Pape Clément', appellation: '', classification: 'Grand Cru Classé de Graves',
      changed: 'classification_as_name',
    };
    const update = buildFixUpdate(polluted, shifted, 'k');
    expect(update.$set.appellation).toBeNull();
    expect(update.$set.classification).toBe('Grand Cru Classé de Graves');
    expect(update.$set.canonicalKey).toBe(computeCanonicalKey('Château Pape Clément', 'Château Pape Clément', ''));
    expect(update.$unset).toEqual({ verifiedChecks: '', crossChecksCleared: '' });
  });
});
