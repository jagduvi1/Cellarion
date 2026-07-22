/**
 * The pre-validate hook keeps canonicalKey in sync with the identity fields —
 * every save-based write path (create, admin rename, strip-producer) gets the
 * fresh key without remembering to compute it. No DB needed: doc.validate()
 * runs the pre-validate middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const oid = () => new mongoose.Types.ObjectId();

const baseDoc = (overrides = {}) => new WineDefinition({
  name: 'Felton Road Block 3 Pinot Noir',
  producer: 'Felton Road Wines Ltd',
  appellation: 'Bannockburn',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  ...overrides,
});

test('computes canonicalKey on new docs — variant input collapses to the canonical identity', async () => {
  const doc = baseDoc();
  await doc.validate();
  expect(doc.canonicalKey).toBe('felton road:block 3 pinot noir:bannockburn');
  expect(doc.canonicalKey).toBe(computeCanonicalKey(doc.name, doc.producer, doc.appellation));
});

test('recomputes on rename', async () => {
  const doc = baseDoc({ name: 'Old Name', appellation: null });
  await doc.validate();
  expect(doc.canonicalKey).toBe('felton road:old name:');

  doc.name = 'Block 5 Pinot Noir';
  await doc.validate();
  expect(doc.canonicalKey).toBe('felton road:block 5 pinot noir:');
});

test('recomputes on producer and appellation changes', async () => {
  const doc = baseDoc();
  await doc.validate();

  doc.appellation = 'Central Otago';
  await doc.validate();
  expect(doc.canonicalKey).toBe('felton road:block 3 pinot noir:central otago');

  doc.producer = 'Maude Wines';
  await doc.validate();
  // name no longer embeds the (new) producer → only the producer segment moves
  expect(doc.canonicalKey).toBe(computeCanonicalKey(doc.name, 'Maude Wines', 'Central Otago'));
});
