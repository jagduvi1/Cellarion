/**
 * The wine record and its label sweetness term (GitHub discussion #1754): the
 * hooks that make the term part of the identity without moving anything for a
 * wine that has none — exercised through validate(), the path every save takes.
 *
 * WHY THIS TEST EXISTS:
 * Thirteen thousand wines have no term. Their keys, their slug and their
 * validation must come out exactly as before — one database read is spent
 * only on a wine that HAS a term, to turn the ref into the printed word the
 * keys and the slug are built from. The hook OWNS the normalizedKey suffix:
 * twenty-five writers build the bare key and none knows the term, so the
 * suffix is re-derived on every validate — appended when a term is set,
 * stripped when it is gone. A wine whose word moved from the name into the
 * field keeps the slug it had (built from the display name). A review marker
 * is cleared by a write to any of the fields it is about.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const SweetnessTerm = require('./SweetnessTerm');
const { computeCanonicalKey } = require('../utils/wineIdentity');
const { generateWineKey } = require('../utils/normalize');

const oid = () => new mongoose.Types.ObjectId();
const BARE = generateWineKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen');
const TERMED = generateWineKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'trocken' });

const fresh = (over = {}) => new WineDefinition({
  name: 'Riesling Kabinett', producer: 'Weingut Keller', appellation: 'Rheinhessen',
  country: oid(), createdBy: oid(), normalizedKey: BARE,
  ...over,
});

/** A saved (non-new) doc as loaded from the DB, nothing modified. */
const loaded = (over = {}) => {
  const doc = fresh({ slug: 'weingut-keller-riesling-kabinett-trocken', ...over });
  doc.isNew = false;
  doc.$__.activePaths.clearModified?.();
  for (const p of ['name', 'producer', 'slug', 'labelSweetness', 'sweetnessReview', 'type', 'sweetnessInName', 'normalizedKey']) doc.unmarkModified(p);
  return doc;
};

const termNamed = (name) => jest.spyOn(SweetnessTerm, 'findById').mockReturnValue({ select: () => ({ lean: async () => (name ? { name } : null) }) });

afterEach(() => jest.restoreAllMocks());

describe('a wine without a term', () => {
  test('validates without touching the term table; its keys are the bare keys it always had', async () => {
    const spy = jest.spyOn(SweetnessTerm, 'findById');
    const doc = fresh();
    await doc.validate();
    expect(spy).not.toHaveBeenCalled();
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen'));
    expect(doc.normalizedKey).toBe(BARE);
    expect(doc.labelSweetness).toBeNull();
    expect(doc.sweetnessInName).toBe(false);
    expect(doc.sweetnessReview).toBeNull();
  });
});

describe('a wine with a term', () => {
  test('one read turns the ref into the word; both identity keys carry it, however bare the writer built them', async () => {
    termNamed('trocken');
    const doc = fresh({ labelSweetness: oid() });
    await doc.validate();
    expect(SweetnessTerm.findById).toHaveBeenCalledTimes(1);
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'trocken' }));
    expect(doc.normalizedKey).toBe(TERMED);
    expect(doc.normalizedKey.endsWith('#sw=trocken')).toBe(true);
  });

  test('an admin edit that recomputed the key BARE over a termed wine gets the suffix back on validate', async () => {
    termNamed('trocken');
    const doc = loaded({ labelSweetness: oid(), normalizedKey: TERMED });
    doc.appellation = 'Rheinhessen';
    doc.normalizedKey = BARE; // what every writer but the Bridge does today
    await doc.validate();
    expect(doc.normalizedKey).toBe(TERMED);
  });

  test('a key already carrying the right suffix is left exactly as it is', async () => {
    termNamed('trocken');
    const doc = fresh({ labelSweetness: oid(), normalizedKey: TERMED });
    await doc.validate();
    expect(doc.normalizedKey).toBe(TERMED);
  });

  test('the term removed: the suffix goes, the key is bare again', async () => {
    const doc = loaded({ labelSweetness: null, normalizedKey: TERMED });
    doc.labelSweetness = null;
    doc.markModified('labelSweetness');
    await doc.validate();
    expect(doc.normalizedKey).toBe(BARE);
  });

  test('a ref nothing answers (a deleted term) keys as no term, never throws', async () => {
    termNamed(null);
    const doc = fresh({ labelSweetness: oid(), normalizedKey: TERMED });
    await doc.validate();
    expect(doc.canonicalKey).toBe(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen'));
    expect(doc.normalizedKey).toBe(BARE);
  });
});

describe('the slug stays where the word moved', () => {
  test('the word leaves the name and enters the term: after validate the slug base is unchanged — no regeneration', async () => {
    termNamed('trocken');
    const doc = loaded({ name: 'Riesling Kabinett trocken' });
    doc.name = 'Riesling Kabinett';
    doc.labelSweetness = oid();
    await doc.validate(); // the pre-validate hook resolves the word, as every save does first
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('a real rename still regenerates, term or no term', async () => {
    termNamed('trocken');
    const doc = loaded({ name: 'Riesling Kabinett trocken' });
    doc.name = 'Riesling Spätlese';
    doc.labelSweetness = oid();
    await doc.validate();
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(true);
  });

  test('an untouched termed wine never churns its slug', async () => {
    termNamed('trocken');
    const doc = loaded({ labelSweetness: oid(), normalizedKey: TERMED });
    await doc.validate();
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });
});

describe('the review marker', () => {
  const marked = () => loaded({ sweetnessReview: { reason: 'unknown_term', detail: 'The registry states "halbsüß"', since: new Date() } });

  test('is cleared by a write to the name, the term, the mark or the type', async () => {
    for (const change of [
      (d) => { d.name = 'Riesling Kabinett halbsüß'; },
      (d) => { d.labelSweetness = oid(); },
      (d) => { d.sweetnessInName = true; },
      (d) => { d.type = 'sparkling'; },
    ]) {
      termNamed('trocken');
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
    doc2.name = 'Riesling Kabinett halbsüß';
    doc2.sweetnessReview = { reason: 'type_mismatch', detail: 'x', since: new Date() };
    await doc2.validate();
    expect(doc2.sweetnessReview).toMatchObject({ reason: 'type_mismatch' });
  });
});
