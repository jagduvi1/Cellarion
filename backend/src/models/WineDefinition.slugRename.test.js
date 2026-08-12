/**
 * Slug correctness on a RENAME — and the promise that no URL ever breaks.
 *
 * THE ROW: Frédéric Magnien's "Coeur de Roi" was a vision misread. Corrected to
 * "Nuits-Saint-Georges Premier Cru Cœur de Roches", it kept serving at
 * /wines/coeur-de-roi — a URL stating a name the wine does not have, indexed by
 * search engines and copied by users. The old rule ("never regenerate, URLs are
 * stable forever") is what produced it.
 *
 * The new rule: regenerate on rename, keep the outgoing slug in previousSlugs,
 * and resolve previousSlugs everywhere a slug is resolved. Stability by
 * redirect, not by staleness.
 *
 * Also re-pins #939's pending-row behaviour, which must survive intact: a
 * pending row takes NO slug (it would squat the real wine's URL), and gets one
 * at promotion — derived from the CORRECTED name.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

/** A saved (non-new) doc with a slug, as loaded from the DB. */
const loaded = (over = {}) => {
  const doc = new WineDefinition({
    name: 'Coeur de Roi',
    producer: 'Frédéric Magnien',
    country: oid(),
    createdBy: oid(),
    normalizedKey: 'frederic magnien:coeur de roi:',
    slug: 'frederic-magnien-coeur-de-roi',
    ...over,
  });
  doc.isNew = false;
  doc.$__.activePaths.clearModified?.();
  doc.unmarkModified('name');
  doc.unmarkModified('producer');
  doc.unmarkModified('slug');
  return doc;
};

describe('shouldRegenerateSlug', () => {
  test('THE ROW: a name correction makes the slug wrong, so it is regenerated', () => {
    const doc = loaded();
    doc.name = 'Nuits-Saint-Georges Premier Cru Cœur de Roches';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(true);
  });

  test('an untouched save never churns the slug', () => {
    expect(WineDefinition.shouldRegenerateSlug(loaded())).toBe(false);
  });

  test('a PRODUCER respelling alone does not — it folds away in the slug anyway', () => {
    const doc = loaded();
    doc.producer = 'Frederic Magnien';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('a rename that produces the SAME slug does not regenerate', () => {
    const doc = loaded();
    doc.name = 'Cóeur De Roi';   // case and accents fold away in the slug
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('a DISAMBIGUATED slug is the right slug for its name and is left alone', () => {
    // "…-2" and the random hex tail are what findFreeSlug appends on a
    // collision; re-saving must not walk them to "-3" forever.
    for (const slug of ['frederic-magnien-coeur-de-roi-2', 'frederic-magnien-coeur-de-roi-a1b2c3d4']) {
      const doc = loaded({ slug });
      doc.name = 'Coeur de Roi';
      doc.markModified('name');
      expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
    }
  });

  test('…but a longer slug that merely starts with the base IS regenerated', () => {
    const doc = loaded({ slug: 'frederic-magnien-coeur-de-roi-premier-cru' });
    doc.name = 'Coeur de Roi';
    doc.markModified('name');
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(true);
  });

  test('a slugless row is shouldAssignSlug\'s business, not this one\'s', () => {
    const doc = loaded({ slug: undefined });
    doc.name = 'Something Else';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('a PENDING row is never re-slugged — it has no public URL to keep correct', () => {
    const doc = loaded({ pendingIdentity: true, producer: '' });
    doc.name = 'Something Else';
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });

  test('a brand-new doc is never regenerated', () => {
    const doc = new WineDefinition({
      name: 'Barolo', producer: 'Rinaldi', country: oid(), createdBy: oid(),
      normalizedKey: 'rinaldi:barolo:', slug: 'rinaldi-barolo',
    });
    expect(WineDefinition.shouldRegenerateSlug(doc)).toBe(false);
  });
});

describe('the outgoing slug stays alive', () => {
  afterEach(() => jest.restoreAllMocks());

  const withFreeSlugs = () => jest.spyOn(WineDefinition, 'findOne').mockImplementation(() => ({
    select: () => ({ lean: async () => null }),
  }));

  test('a rename pushes the old slug onto previousSlugs and takes the new one', async () => {
    withFreeSlugs();
    const doc = loaded();
    doc.name = 'Nuits-Saint-Georges Premier Cru Cœur de Roches';

    // Run the save hooks without a live connection.
    await new Promise((resolve, reject) =>
      doc.constructor.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve())));

    expect(doc.slug).toBe('frederic-magnien-nuitssaintgeorges-premier-cru-cur-de-roches');
    expect(doc.previousSlugs).toEqual(['frederic-magnien-coeur-de-roi']);
  });

  test('previousSlugs is bounded and never records the slug the wine currently has', async () => {
    withFreeSlugs();
    const doc = loaded({ previousSlugs: Array.from({ length: 12 }, (_, i) => `old-${i}`) });
    doc.name = 'Nuits-Saint-Georges Premier Cru Cœur de Roches';

    await new Promise((resolve, reject) =>
      doc.constructor.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve())));

    expect(doc.previousSlugs).toHaveLength(10);
    expect(doc.previousSlugs).not.toContain(doc.slug);
    expect(doc.previousSlugs[doc.previousSlugs.length - 1]).toBe('frederic-magnien-coeur-de-roi');
  });

  test('findFreeSlug refuses a candidate another wine still answers to', async () => {
    // Otherwise one old URL would resolve to two different wines.
    const seen = [];
    jest.spyOn(WineDefinition, 'findOne').mockImplementation((filter) => {
      seen.push(filter);
      const wanted = filter.$or[0].slug;
      return { select: () => ({ lean: async () => (wanted === 'taken' ? { _id: 'x' } : null) }) };
    });

    await WineDefinition.findFreeSlug('taken');

    expect(seen[0]).toEqual({ $or: [{ slug: 'taken' }, { previousSlugs: 'taken' }] });
  });
});

describe('slugFilter — every :idOrSlug lookup resolves an old link', () => {
  test('it matches the current slug OR a superseded one, lowercased', () => {
    expect(WineDefinition.slugFilter('Coeur-De-Roi')).toEqual({
      $or: [{ slug: 'coeur-de-roi' }, { previousSlugs: 'coeur-de-roi' }],
    });
  });
});

describe('#939 pending-row slug behaviour is intact', () => {
  const newPending = (name) => new WineDefinition({
    name, producer: '', country: oid(), createdBy: oid(),
    normalizedKey: `pending~aaa:${name}:`, pendingIdentity: true,
  });

  test('a pending row takes NO slug — it would squat the real wine\'s URL (M-5)', () => {
    expect(WineDefinition.shouldAssignSlug(newPending('Coeur de Roi'))).toBe(false);
  });

  test('promotion assigns one, derived from the CORRECTED name', async () => {
    jest.spyOn(WineDefinition, 'findOne').mockImplementation(() => ({
      select: () => ({ lean: async () => null }),
    }));
    const doc = newPending('Coeur de Roi');
    // A curator fixes both fields in one call, as fix_pending_wine encourages.
    doc.name = 'Nuits-Saint-Georges Premier Cru Cœur de Roches';
    doc.producer = 'Frédéric Magnien';
    await doc.validate();                       // pre-validate promotes
    expect(doc.pendingIdentity).toBe(false);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(true);

    await new Promise((resolve, reject) =>
      doc.constructor.hooks.execPre('save', doc, (err) => (err ? reject(err) : resolve())));

    // The corrected name, not the misread one it was minted with.
    expect(doc.slug).toBe('frederic-magnien-nuitssaintgeorges-premier-cru-cur-de-roches');
    expect(doc.previousSlugs).toBeUndefined();  // it never had a slug to supersede
    jest.restoreAllMocks();
  });
});
