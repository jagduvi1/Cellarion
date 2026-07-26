/**
 * The pre-validate hook clears the human-review record (verifiedChecks /
 * verifiedAt) when — and ONLY when — `name` or `producer` changes on an
 * existing doc. The only-when half is the load-bearing part: taxonomy repairs,
 * image swaps and the USER-REACHABLE communityRating write
 * (services/reviewAggregation.js fires on every review) must never un-verify a
 * curated wine. No DB needed: doc.validate() runs the pre-validate middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

const baseDoc = (overrides = {}) => new WineDefinition({
  name: 'Block 3 Pinot Noir',
  producer: 'Felton Road',
  appellation: 'Bannockburn',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'raw:key:x',
  ...overrides,
});

// A doc that has been saved once ($isNew false, no dirty paths) and carries
// clearances — the state of a prod row an admin reviewed. A fresh constructor
// marks EVERY path modified, so unmark the two the hook watches to simulate a
// loaded document; the other paths don't matter (the hook ignores them).
const reviewedDoc = async () => {
  const doc = baseDoc({
    verifiedChecks: ['name-equals-producer.v1', 'dangling-name-tail.v2'],
    verifiedAt: new Date('2026-07-26T10:00:00Z'),
  });
  doc.$isNew = false;
  doc.unmarkModified('name');
  doc.unmarkModified('producer');
  await doc.validate();
  expect(doc.verifiedChecks).toEqual(['name-equals-producer.v1', 'dangling-name-tail.v2']);
  return doc;
};

test('a new doc is born unreviewed', async () => {
  const doc = baseDoc();
  await doc.validate();
  expect((doc.verifiedChecks || []).length).toBe(0);
  expect(doc.verifiedAt).toBeNull();
});

test('changing name clears both fields', async () => {
  const doc = await reviewedDoc();
  doc.name = 'Block 5 Pinot Noir';
  await doc.validate();
  expect((doc.verifiedChecks || []).length).toBe(0);
  expect(doc.verifiedAt).toBeNull();
});

test('changing producer clears both fields', async () => {
  const doc = await reviewedDoc();
  doc.producer = 'Maude Wines';
  await doc.validate();
  expect((doc.verifiedChecks || []).length).toBe(0);
  expect(doc.verifiedAt).toBeNull();
});

test('THE FALSE-CLEAR GUARD: every other field change leaves the record intact', async () => {
  // Protects the user-reachable reviewAggregation communityRating write and
  // the merge keeper's image adoption from silently un-verifying wines.
  const mutations = [
    (d) => { d.appellation = 'Central Otago'; },
    (d) => { d.country = oid(); },
    (d) => { d.region = oid(); },
    (d) => { d.grapes = [oid()]; },
    (d) => { d.type = 'white'; },
    (d) => { d.image = 'https://example.com/x.png'; },
    (d) => { d.imageCredit = 'Someone'; },
    (d) => { d.aiProfile.description = 'Bright cherry.'; },
    (d) => { d.communityRating.reviewCount = 7; },
  ];
  for (const mutate of mutations) {
    const doc = await reviewedDoc();
    mutate(doc);
    await doc.validate();
    expect(doc.verifiedChecks).toEqual(['name-equals-producer.v1', 'dangling-name-tail.v2']);
    expect(doc.verifiedAt).toEqual(new Date('2026-07-26T10:00:00Z'));
  }
});

test('reassigning an IDENTICAL name does not clear (the admin PUT posts the whole form)', async () => {
  // routes/admin/wines.js PUT /:id assigns wine.name = name.trim()
  // unconditionally; Mongoose does not mark a path modified when a primitive
  // is reassigned to an identical value — the behaviour this design leans on.
  const doc = await reviewedDoc();
  doc.name = 'Block 3 Pinot Noir';
  doc.producer = 'Felton Road';
  await doc.validate();
  expect(doc.verifiedChecks).toEqual(['name-equals-producer.v1', 'dangling-name-tail.v2']);
  expect(doc.verifiedAt).toEqual(new Date('2026-07-26T10:00:00Z'));
});

test('validate with no modification leaves the record intact', async () => {
  const doc = await reviewedDoc();
  await doc.validate();
  expect(doc.verifiedChecks).toEqual(['name-equals-producer.v1', 'dangling-name-tail.v2']);
});

test('regression: canonicalKey still recomputes on an appellation change', async () => {
  const doc = await reviewedDoc();
  const before = doc.canonicalKey;
  doc.appellation = 'Central Otago';
  await doc.validate();
  expect(doc.canonicalKey).not.toBe(before);
  expect(doc.verifiedChecks).toEqual(['name-equals-producer.v1', 'dangling-name-tail.v2']);
});
