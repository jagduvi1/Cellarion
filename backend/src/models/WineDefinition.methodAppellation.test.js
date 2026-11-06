/**
 * The pre-validate hook's PRODUCTION METHOD rule (GitHub discussion #1696): a
 * value that is nothing but a method ("Méthode Traditionnelle") is no
 * appellation, so it never stores as one — on any save-based write — and the
 * canonical key derived in the same hook carries no appellation. No DB
 * needed: doc.validate() runs the middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const oid = () => new mongoose.Types.ObjectId();

const newWine = (overrides = {}) => new WineDefinition({
  name: 'Blanc de Blancs',
  producer: 'Pongrácz',
  appellation: 'Western Cape',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  type: 'sparkling',
  ...overrides,
});

test('a method typed as the appellation stores as none, and the canonical key has no appellation', async () => {
  const doc = newWine({ appellation: 'Méthode Cap Classique' });
  await doc.validate();
  expect(doc.appellation).toBeNull();
  expect(doc.canonicalKey).toBe(computeCanonicalKey('Blanc de Blancs', 'Pongrácz', ''));
});

test('a later edit to a method stores as none too', async () => {
  const doc = newWine();
  await doc.validate();
  doc.$isNew = false;
  doc.appellation = 'Metodo Classico';
  await doc.validate();
  expect(doc.appellation).toBeNull();
});

test('a real appellation, and one whose legal name ends in the method, are kept', async () => {
  for (const appellation of ['Western Cape', 'Oltrepò Pavese Metodo Classico', 'Clairette de Die Méthode Dioise Ancestrale']) {
    const doc = newWine({ appellation });
    await doc.validate();
    expect(doc.appellation).toBe(appellation);
  }
});
