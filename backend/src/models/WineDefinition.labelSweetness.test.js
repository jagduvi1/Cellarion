/**
 * The wine record and its label sweetness term (GitHub discussion #1754): the
 * hooks that make the term part of the identity without moving anything for a
 * wine that has none.
 *
 * WHY THIS TEST EXISTS:
 * Thirteen thousand wines have no term. Their canonical key, their slug and
 * their validation must come out exactly as before — one database read is
 * spent only on a wine that HAS a term, to turn the ref into the printed word
 * the keys and the slug are built from. A wine whose word moved from the name
 * into the field keeps the slug it had (built from the display name). A review
 * marker is cleared by a write to any of the fields it is about.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const SweetnessTerm = require('./SweetnessTerm');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const oid = () => new mongoose.Types.ObjectId();

const fresh = (over = {}) => new WineDefinition({
  name: 'Riesling Kabinett', producer: 'Weingut Keller', appellation: 'Rheinhessen',
  country: oid(), createdBy: oid(), normalizedKey: 'weingut keller:riesling kabinett:rheinhessen',
  ...over,
});

/** A saved (non-new) doc as loaded from the DB, nothing modified. */
const loaded = (over = {}) => {
  const doc = fresh({ slug: 'weingut-keller-riesling-kabinett-trocken', ...over });
  doc.isNew = false;
  doc.$__.activePaths.clearModified?.();
  for (const p of ['name', 'producer', 'slug', 'labelSweetness', 'sweetnessReview', 'type', 'sweetnessInName']) doc.unmarkModified(p);
  return doc;
};

afterEach(() => jest.restoreAllMocks());

describe('a wine without a term', () => {
  test('validates without touching the term table; its canonical key is the three-argument key it always had', async () => {
    const spy = jest.spyOn(SweetnessTerm, 'findById');
    const doc = fresh();
    await doc.validate();
    expect(spy).not.toHaveBeenCalled();
    expect(doc.$locals.sweetnessName).toBeNull();
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen'));
    expect(doc.labelSweetness).toBeNull();
    expect(doc.sweetnessInName).toBe(false);
    expect(doc.sweetnessReview).toBeNull();
  });
});

describe('a wine with a term', () => {
  test('one read turns the ref into the word; the canonical key carries it', async () => {
    jest.spyOn(SweetnessTerm, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Trocken' }) }) });
    const doc = fresh({ labelSweetness: oid() });
    await doc.validate();
    expect(SweetnessTerm.findById).toHaveBeenCalledTimes(1);
    expect(doc.$locals.sweetnessName).toBe('Trocken');
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'Trocken' }));
    expect(doc.canonicalKey.endsWith('#sw=trocken')).toBe(true);
  });

  test('a ref nothing answers (a deleted term) keys as no term, never throws', async () => {
    jest.spyOn(SweetnessTerm, 'findById').mockReturnValue({ select: () => ({ lean: async () => null }) });
    const doc = fresh({ labelSweetness: oid() });
    await doc.validate();
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen'));
  });
});

describe('the slug stays where the word moved', () => {
  test('the word leaves the name and enters the term: the display name — and so the slug base — is unchanged, no regeneration', () => {
    const doc = loaded({ name: 'Riesling Kabinett trocken' });
    doc.name = 'Riesling Kabinett';
    doc.labelSweetness = oid();
    doc.$locals.sweetnessName = 'Trocken'; // what the pre-validate hook resolves before any save
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('without the resolved word the same change WOULD regenerate — the hook order is what keeps the URL', () => {
    const doc = loaded({ name: 'Riesling Kabinett trocken' });
    doc.name = 'Riesling Kabinett';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(true);
  });

  test('a real rename still regenerates, term or no term', () => {
    const doc = loaded({ name: 'Riesling Kabinett trocken' });
    doc.name = 'Riesling Spätlese';
    doc.$locals.sweetnessName = 'Trocken';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(true);
  });
});

describe('the review marker', () => {
  const marked = () => loaded({ sweetnessReview: { reason: 'unknown_term', detail: 'The registry states "Halbsüß"', since: new Date() } });

  test('is cleared by a write to the name, the term, the mark or the type', async () => {
    for (const change of [
      (d) => { d.name = 'Riesling Kabinett Halbsüß'; },
      (d) => { d.labelSweetness = oid(); },
      (d) => { d.sweetnessInName = true; },
      (d) => { d.type = 'sparkling'; },
    ]) {
      jest.spyOn(SweetnessTerm, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Trocken' }) }) });
      const doc = marked();
      change(doc);
      await doc.validate();
      expect(doc.sweetnessReview).toBeNull();
      jest.restoreAllMocks();
    }
  });

  test('survives a write to anything else, and a write that sets the marker itself', async () => {
    const doc = marked();
    doc.producer = 'Klaus Peter Keller';
    await doc.validate();
    expect(doc.sweetnessReview).toMatchObject({ reason: 'unknown_term' });

    const doc2 = loaded();
    doc2.name = 'Riesling Kabinett Halbsüß';
    doc2.sweetnessReview = { reason: 'type_mismatch', detail: 'x', since: new Date() };
    await doc2.validate();
    expect(doc2.sweetnessReview).toMatchObject({ reason: 'type_mismatch' });
  });
});
