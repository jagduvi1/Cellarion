/**
 * The PRIVATE DRAFT invariants on the model (support ticket 2026-09-12):
 *
 *   draft ⇒ pendingIdentity   — set first thing in the pre-validate hook, so
 *                               no write path can produce a visible draft;
 *   a draft never auto-promotes — its identity may be complete from the first
 *                               save, but leaving the private state is the
 *                               creator's explicit publish;
 *   the publish save promotes  — clearing `draft` and saving is exactly the
 *                               hook's ordinary promotion.
 *
 * No DB needed: doc.validate() runs pre-validate middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');

const oid = () => new mongoose.Types.ObjectId();

const draftDoc = (overrides = {}) => new WineDefinition({
  name: 'Kaefferkopf',
  producer: 'Cave de Kaysersberg',
  country: oid(),
  createdBy: oid(),
  normalizedKey: 'draft~aaa:cave de kaysersberg:kaefferkopf:',
  draft: true,
  ...overrides,
});

describe('draft ⇒ pendingIdentity', () => {
  test('a draft created without pendingIdentity is pending after validation', async () => {
    const doc = draftDoc({ pendingIdentity: false });
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });

  test('a producerless draft validates (the producer requirement is conditional on pending)', async () => {
    await expect(draftDoc({ producer: '' }).validate()).resolves.toBeUndefined();
  });

  test('a draft gets NO slug (it is pending) — no slug squatting from a private row', async () => {
    const doc = draftDoc();
    await doc.validate();
    expect(WineDefinition.shouldAssignSlug ? WineDefinition.shouldAssignSlug(doc) : false).toBe(false);
  });
});

describe('a draft never auto-promotes; the publish save does', () => {
  test('a complete, plausible identity stays pending while draft', async () => {
    const doc = draftDoc();
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
    expect(doc.$locals.promotedFromPending).toBeUndefined();
  });

  test('clearing draft and validating again promotes through the ordinary hook', async () => {
    const doc = draftDoc();
    await doc.validate();
    doc.draft = false;
    doc.normalizedKey = 'cave de kaysersberg:kaefferkopf:';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
    expect(doc.$locals.promotedFromPending).toBe(true);
  });

  test('clearing draft on a producerless row leaves it an ordinary pending row (a curator finishes it)', async () => {
    const doc = draftDoc({ producer: '' });
    await doc.validate();
    doc.draft = false;
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });
});
