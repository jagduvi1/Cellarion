/**
 * M-2 and M-5 from the pending-identity security audit. (M-3 needs the AI
 * provider mocked at module scope and lives in enrichmentJob.pendingIdentity.)
 *
 *   M-2  services/pendingWineOps regenerated normalizedKey with generateWineKey
 *        on ANY name/appellation edit — including while the row was STILL
 *        pending. That drops the creator id out of the key, breaking the
 *        documented namespace invariant, so two curator-renamed pending rows by
 *        different users could collide into a false "merge them instead" 409.
 *   M-5  models/WineDefinition assigned a slug to pending rows, permanently
 *        squatting the real wine's URL (which 404s for everyone), and never
 *        regenerated on promotion.
 */

const mongoose = require('mongoose');
const { pendingWineKey, generateWineKey } = require('../utils/normalize');

const oid = () => new mongoose.Types.ObjectId();

describe('M-2 — the pending key namespace survives a curator rename', () => {
  const CREATOR_A = oid();
  const CREATOR_B = oid();

  test('two different creators with the same renamed identity get DIFFERENT keys', () => {
    const a = pendingWineKey('Kaefferkopf Grand Cru', CREATOR_A, 'Alsace');
    const b = pendingWineKey('Kaefferkopf Grand Cru', CREATOR_B, 'Alsace');
    expect(a).not.toBe(b);
  });

  test('the pending namespace is provably disjoint from every real producer key', () => {
    const pending = pendingWineKey('Kaefferkopf', CREATOR_A, '');
    expect(pending).toContain('pending~');
    // normalizeString emits [a-z0-9 ] only, so '~' cannot appear in a real key.
    expect(generateWineKey('Kaefferkopf', 'Cave de Kaysersberg', '')).not.toContain('~');
  });

  test('the SAME creator renaming twice keys deterministically (a retry resolves, not mints)', () => {
    expect(pendingWineKey('Kaefferkopf', CREATOR_A, 'Alsace'))
      .toBe(pendingWineKey('Kaefferkopf', CREATOR_A, 'Alsace'));
  });

  test('THE BUG: generateWineKey on a still-pending row collapses both creators onto one key', () => {
    // producer is '' while pending, so the ordinary key builder produces
    // ':<name>:<appellation>' — identical for every creator. This is what the
    // fix stops pendingWineOps from doing before the row actually promotes.
    const asOrdinary = generateWineKey('Kaefferkopf Grand Cru', '', 'Alsace');
    expect(asOrdinary).toBe(generateWineKey('Kaefferkopf Grand Cru', '', 'Alsace'));
    expect(asOrdinary).not.toContain('pending~');
  });
});

describe('M-5 — a pending row gets no slug, and gets one when it promotes', () => {
  const WineDefinition = require('../models/WineDefinition');

  const newPending = () => new WineDefinition({
    name: 'Cloudy Bay Sauvignon Blanc',
    producer: '',
    country: oid(),
    createdBy: oid(),
    normalizedKey: 'pending~aaa:cloudy bay sauvignon blanc:',
    pendingIdentity: true,
  });

  test('a NEW pending row is refused a slug — the real wine keeps its URL', () => {
    expect(WineDefinition.shouldAssignSlug(newPending())).toBe(false);
  });

  test('an ordinary new wine still gets one', () => {
    const doc = new WineDefinition({
      name: 'Sauvignon Blanc', producer: 'Cloudy Bay', country: oid(), createdBy: oid(),
      normalizedKey: 'cloudy bay:sauvignon blanc:',
    });
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(true);
  });

  test('PROMOTION assigns the slug the pending row never took', async () => {
    const doc = newPending();
    doc.producer = 'Cloudy Bay';
    await doc.validate();            // pre-validate promotes
    expect(doc.pendingIdentity).toBe(false);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(true);
  });

  test('a pending row edited but still pending stays slugless', async () => {
    const doc = newPending();
    doc.name = 'Cloudy Bay Sauvignon Blanc Reserve';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(false);
  });

  test('an existing slug is never overwritten — URL stability', async () => {
    const doc = newPending();
    doc.slug = 'already-has-one';
    doc.producer = 'Cloudy Bay';
    await doc.validate();
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(false);
  });

  test('a slugless LEGACY row is left to the migration script, not to a passing write', () => {
    const doc = new WineDefinition({
      name: 'Barolo', producer: 'Rinaldi', country: oid(), createdBy: oid(),
      normalizedKey: 'rinaldi:barolo:',
    });
    doc.isNew = false;               // loaded from the DB, no pendingIdentity change
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(false);
  });
});

describe('M-5 — the disambiguation loop no longer falls through silently', () => {
  const WineDefinition = require('../models/WineDefinition');

  const withSlugLookup = (isTaken) => {
    const spy = jest.spyOn(WineDefinition, 'findOne').mockImplementation(({ slug }) => ({
      select: () => ({ lean: async () => (isTaken(slug) ? { _id: 'x' } : null) }),
    }));
    return spy;
  };

  afterEach(() => jest.restoreAllMocks());

  test('a free base slug is used as-is', async () => {
    withSlugLookup(() => false);
    await expect(WineDefinition.findFreeSlug('cloudy-bay')).resolves.toBe('cloudy-bay');
  });

  test('a taken base steps to -2', async () => {
    withSlugLookup((s) => s === 'cloudy-bay');
    await expect(WineDefinition.findFreeSlug('cloudy-bay')).resolves.toBe('cloudy-bay-2');
  });

  test('THE BUG: with every suffix taken it returns a CHECKED slug, not a colliding one', async () => {
    // Everything the loop can produce is taken — the old code assigned
    // `${base}-99` unchecked, straight into a unique-index write failure.
    const exhausted = (s) => /^cloudy-bay(-\d{1,2})?$/.test(s);
    withSlugLookup(exhausted);

    const slug = await WineDefinition.findFreeSlug('cloudy-bay');

    expect(slug).not.toBe('cloudy-bay-99');
    expect(exhausted(slug)).toBe(false);
    expect(slug).toMatch(/^cloudy-bay-[0-9a-f]{8}$/);
  });
});
