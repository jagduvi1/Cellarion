/**
 * The pre-validate hook's CLASSIFICATION rule (GitHub discussion #1696): the
 * appellation's regulatory mark (DOCG, DOC, AOC, …) is not a quality tier, so
 * it never stores as one — on any save-based write, whatever surface typed
 * it. No DB needed: doc.validate() runs the middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

const newWine = (overrides = {}) => new WineDefinition({
  name: 'Barolo',
  producer: 'Azelia',
  appellation: 'Barolo',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  type: 'red',
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

describe('on create', () => {
  test('a regulatory mark typed as the classification stores as none', async () => {
    const doc = newWine({ classification: 'DOCG' });
    await doc.validate();
    expect(doc.classification).toBeNull();
  });

  test('a spelled-out mark stores as none', async () => {
    const doc = newWine({ classification: 'Denominazione di Origine Controllata e Garantita' });
    await doc.validate();
    expect(doc.classification).toBeNull();
  });

  test('a tier keeps its text, with a trailing mark dropped', async () => {
    const doc = newWine({ classification: 'Riserva DOCG' });
    await doc.validate();
    expect(doc.classification).toBe('Riserva');
  });

  test('a real classification is untouched', async () => {
    const doc = newWine({ classification: 'Grand Cru Classé en 1855' });
    await doc.validate();
    expect(doc.classification).toBe('Grand Cru Classé en 1855');
  });

  test('no classification stays no classification', async () => {
    const doc = newWine();
    await doc.validate();
    expect(doc.classification).toBeNull();
  });
});

describe('on a later save', () => {
  test('an edit that sets the mark clears the stored tier', async () => {
    const doc = await savedWine({ classification: 'Riserva' });
    doc.classification = 'DOC';
    await doc.validate();
    expect(doc.classification).toBeNull();
  });

  test('an unrelated edit leaves the stored tier alone', async () => {
    const doc = await savedWine({ classification: 'Riserva' });
    doc.name = 'Barolo Bricco Fiasco';
    await doc.validate();
    expect(doc.classification).toBe('Riserva');
  });
});
