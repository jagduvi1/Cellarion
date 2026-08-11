/**
 * The pendingIdentity AUTO-PROMOTE hook and the conditional producer
 * requirement.
 *
 * Promotion is a model hook, not a line in the somm route, precisely so no
 * write path can forget it — this suite is what pins that. It also pins the
 * other half of the bargain: `producer` is required for every row EXCEPT a
 * pending one, so the relaxation cannot leak into ordinary wines.
 *
 * No DB needed: doc.validate() runs pre-validate middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

const pendingDoc = (overrides = {}) => new WineDefinition({
  name: 'Kaefferkopf',
  producer: '',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'pending~aaa:kaefferkopf:',
  pendingIdentity: true,
  ...overrides,
});

describe('producer requirement is conditional on pendingIdentity', () => {
  test('a pending row validates with an empty producer', async () => {
    await expect(pendingDoc().validate()).resolves.toBeUndefined();
  });

  test('an ORDINARY row still refuses an empty producer', async () => {
    const doc = pendingDoc({ pendingIdentity: false });
    await expect(doc.validate()).rejects.toMatchObject({
      errors: expect.objectContaining({ producer: expect.anything() }),
    });
  });

  test('an ordinary row with a real producer validates', async () => {
    const doc = pendingDoc({ pendingIdentity: false, producer: 'Cave de Kaysersberg' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

describe('auto-promote: a pending row leaves the queue the moment its identity is real', () => {
  test('setting a real producer promotes on validate', async () => {
    const doc = pendingDoc();
    doc.producer = 'Cave de Kaysersberg';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('the canonical key is recomputed from the completed identity', async () => {
    const doc = pendingDoc();
    doc.producer = 'Cave de Kaysersberg';
    await doc.validate();
    expect(doc.canonicalKey.startsWith('cave kaysersberg:')).toBe(true);
  });

  test.each([
    ['Unknown', 'Unknown'],
    ['N/A', 'N/A'],
    ['-', '-'],
    ['?', '?'],
    ['none', 'none'],
    ['Domaine Unknown', 'Domaine Unknown'],
    ['whitespace', '   '],
  ])('a SENTINEL producer (%s) does NOT promote — the row stays hidden', async (_label, producer) => {
    const doc = pendingDoc();
    doc.producer = producer;
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });

  test('a sentinel NAME blocks promotion even with a real producer', async () => {
    const doc = pendingDoc({ name: 'Unknown' });
    doc.producer = 'Cave de Kaysersberg';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });

  test('promotion happens on a fresh CREATE too, not only on an edit', async () => {
    // A caller that mints with pendingIdentity:true but a complete identity is
    // simply wrong; the hook corrects it rather than hiding a good wine.
    const doc = pendingDoc({ producer: 'Cave de Kaysersberg' });
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('an ordinary wine is never touched by the hook', async () => {
    const doc = pendingDoc({ pendingIdentity: false, producer: 'Cave de Kaysersberg' });
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });
});

describe('scanImage', () => {
  test('defaults to null and accepts a BottleImage ref', async () => {
    expect(pendingDoc().scanImage).toBeNull();
    const id = oid();
    const doc = pendingDoc({ scanImage: id });
    await doc.validate();
    expect(String(doc.scanImage)).toBe(String(id));
  });
});
