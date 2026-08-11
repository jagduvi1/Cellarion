/**
 * Grape.regionalNames — schema-level validation for the regional display
 * names path (somm ticket: "Tinta Roriz stored as Tempranillo on a Douro
 * Port").
 *
 * WHY THIS TEST EXISTS:
 * The admin route validates payload shape, but the schema is the last line —
 * scripts and future write paths hit it directly. Pins: country is required
 * per entry, name is required and capped at 60 (trimmed first), region is
 * optional, the array defaults to [], and — deliberately — there is NO
 * normalized copy of these names (display-only; matching stays the job of
 * synonyms/normalizedSynonyms). No DB needed: doc.validate() runs the
 * validators without touching pre-save hooks.
 */
const mongoose = require('mongoose');
const Grape = require('./Grape');

const oid = () => new mongoose.Types.ObjectId();

const baseDoc = (overrides = {}) => new Grape({
  name: 'Tempranillo',
  normalizedName: 'tempranillo',
  createdBy: oid(),
  ...overrides,
});

test('regionalNames defaults to [] — existing grapes are unaffected', async () => {
  const doc = baseDoc();
  await doc.validate();
  expect(doc.regionalNames.length).toBe(0);
});

test('accepts country-only and country+region entries; name is trimmed', async () => {
  const country = oid();
  const doc = baseDoc({
    regionalNames: [
      { country, region: oid(), name: '  Tinta Roriz  ' },
      { country, name: 'Aragonez' },
    ],
  });
  await doc.validate();
  expect(doc.regionalNames[0].name).toBe('Tinta Roriz');
  expect(doc.regionalNames[1].region).toBeNull();
});

test('country is required on every entry', async () => {
  const doc = baseDoc({ regionalNames: [{ name: 'Tinta Roriz' }] });
  await expect(doc.validate()).rejects.toThrow(/regionalNames.0.country/);
});

test('name is required and capped at 60 chars', async () => {
  await expect(baseDoc({ regionalNames: [{ country: oid() }] }).validate())
    .rejects.toThrow(/regionalNames.0.name/);
  // Whitespace-only trims to empty → required fails.
  await expect(baseDoc({ regionalNames: [{ country: oid(), name: '   ' }] }).validate())
    .rejects.toThrow(/regionalNames.0.name/);
  await expect(baseDoc({ regionalNames: [{ country: oid(), name: 'a'.repeat(61) }] }).validate())
    .rejects.toThrow(/regionalNames.0.name/);
  await baseDoc({ regionalNames: [{ country: oid(), name: 'a'.repeat(60) }] }).validate();
});

test('display-only contract: the schema has no normalized copy of regional names', () => {
  // Matching a typed "Tinta Roriz" to this doc is synonyms' job — if someone
  // adds a normalizedRegionalNames-style field, the display/matching split
  // this feature rests on has been broken. See the schema comment.
  const paths = Object.keys(Grape.schema.paths);
  expect(paths.some((p) => /normalized.*regional/i.test(p))).toBe(false);
  expect(paths).toContain('normalizedSynonyms'); // matching stays here
});
