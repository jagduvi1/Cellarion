/**
 * The pre-validate hook clears the cross-field review record
 * (crossChecksCleared / crossChecksClearedAt) when — and only when — one of
 * the SIX identity fields (name, producer, appellation, region, country,
 * grapes) changes on an existing doc. Sibling of
 * WineDefinition.verifiedChecks.test.js, with the deliberate divergence
 * pinned in both directions: an appellation/region/country/grapes change
 * invalidates crossChecksCleared (its rules read those fields against the
 * taxonomy) but must NOT touch verifiedChecks (whose invariant is
 * name+producer-only). No DB needed: doc.validate() runs the middleware.
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

const CLEARED = ['producer-is-appellation.v1', 'region-is-country.v1'];
const CLEARED_AT = new Date('2026-08-10T10:00:00Z');
const VERIFIED = ['name-equals-producer.v1'];

// A saved doc carrying clearances for BOTH families — the state of a prod row
// an admin reviewed in both queues. A fresh constructor marks EVERY path
// modified, so unmark the six the cross-field hook watches (name/producer
// also cover the verifiedChecks hook).
const reviewedDoc = async () => {
  const doc = baseDoc({
    crossChecksCleared: [...CLEARED],
    crossChecksClearedAt: CLEARED_AT,
    verifiedChecks: [...VERIFIED],
    verifiedAt: CLEARED_AT,
  });
  doc.$isNew = false;
  for (const path of ['name', 'producer', 'appellation', 'region', 'country', 'grapes']) {
    doc.unmarkModified(path);
  }
  await doc.validate();
  expect(doc.crossChecksCleared).toEqual(CLEARED);
  return doc;
};

test('a new doc is born with no cross-field clearances', async () => {
  const doc = baseDoc();
  await doc.validate();
  expect((doc.crossChecksCleared || []).length).toBe(0);
  expect(doc.crossChecksClearedAt).toBeNull();
});

describe('each of the six identity fields clears the record', () => {
  const mutations = [
    ['name', (d) => { d.name = 'Block 5 Pinot Noir'; }],
    ['producer', (d) => { d.producer = 'Maude Wines'; }],
    ['appellation', (d) => { d.appellation = 'Central Otago'; }],
    ['region', (d) => { d.region = oid(); }],
    ['country', (d) => { d.country = oid(); }],
    ['grapes', (d) => { d.grapes = [oid()]; }],
  ];
  test.each(mutations)('changing %s clears crossChecksCleared + clearedAt', async (_field, mutate) => {
    const doc = await reviewedDoc();
    mutate(doc);
    await doc.validate();
    expect((doc.crossChecksCleared || []).length).toBe(0);
    expect(doc.crossChecksClearedAt).toBeNull();
  });
});

test('THE FALSE-CLEAR GUARD: non-identity field changes leave the record intact', async () => {
  const mutations = [
    (d) => { d.type = 'white'; },
    (d) => { d.image = 'https://example.com/x.png'; },
    (d) => { d.imageCredit = 'Someone'; },
    (d) => { d.aiProfile.description = 'Bright cherry.'; },
    (d) => { d.communityRating.reviewCount = 7; },
    (d) => { d.nonWine = true; },
  ];
  for (const mutate of mutations) {
    const doc = await reviewedDoc();
    mutate(doc);
    await doc.validate();
    expect(doc.crossChecksCleared).toEqual(CLEARED);
    expect(doc.crossChecksClearedAt).toEqual(CLEARED_AT);
  }
});

test('THE DIVERGENCE, PINNED BOTH WAYS: an appellation change clears the cross-field record but not verifiedChecks', async () => {
  const doc = await reviewedDoc();
  doc.appellation = 'Central Otago';
  await doc.validate();
  expect((doc.crossChecksCleared || []).length).toBe(0);
  expect(doc.verifiedChecks).toEqual(VERIFIED); // name+producer-only invariant holds
});

test('a name change clears BOTH families (name is in both scopes)', async () => {
  const doc = await reviewedDoc();
  doc.name = 'Block 5 Pinot Noir';
  await doc.validate();
  expect((doc.crossChecksCleared || []).length).toBe(0);
  expect((doc.verifiedChecks || []).length).toBe(0);
});

test('reassigning IDENTICAL values does not clear (the admin PUT posts the whole form)', async () => {
  const doc = await reviewedDoc();
  doc.name = 'Block 3 Pinot Noir';
  doc.producer = 'Felton Road';
  doc.appellation = 'Bannockburn';
  await doc.validate();
  expect(doc.crossChecksCleared).toEqual(CLEARED);
  expect(doc.crossChecksClearedAt).toEqual(CLEARED_AT);
});
