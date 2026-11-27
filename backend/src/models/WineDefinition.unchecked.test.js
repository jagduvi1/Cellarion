/**
 * The UNCHECKED IDENTITY invariants on the model:
 *
 *   uncheckedIdentity ⇒ pendingIdentity — set first thing in the pre-validate
 *                              hook, so no write path can publish a wine taken
 *                              from a member's own data before a curator has
 *                              checked it;
 *   it never auto-promotes   — its producer and name are usually complete from
 *                              the first save, which is exactly when a row
 *                              pending for a missing producer leaves the queue;
 *   the check promotes       — clearing the flag and saving is the hook's
 *                              ordinary promotion.
 *
 * No DB needed: doc.validate() runs pre-validate middleware.
 */
const mongoose = require('mongoose');
const WineDefinition = require('./WineDefinition');
const { uncheckedWineKey, generateWineKey, UNCHECKED_KEY_PREFIX, normalizeString } = require('../utils/normalize');

const oid = () => new mongoose.Types.ObjectId();
const CREATOR = oid();

const uncheckedDoc = (overrides = {}) => new WineDefinition({
  name: 'Kaefferkopf',
  producer: 'Cave de Kaysersberg',
  country: oid(),
  createdBy: CREATOR,
  normalizedKey: uncheckedWineKey('Kaefferkopf', 'Cave de Kaysersberg', CREATOR),
  uncheckedIdentity: true,
  ...overrides,
});

describe('uncheckedIdentity ⇒ pendingIdentity', () => {
  test('a row created without pendingIdentity is pending after validation', async () => {
    const doc = uncheckedDoc({ pendingIdentity: false });
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });

  test('a producerless unchecked row validates (the producer requirement is conditional on pending)', async () => {
    await expect(uncheckedDoc({ producer: '' }).validate()).resolves.toBeUndefined();
  });

  test('an ordinary wine is not touched by the invariant', async () => {
    const doc = uncheckedDoc({ uncheckedIdentity: false, normalizedKey: generateWineKey('Kaefferkopf', 'Cave de Kaysersberg') });
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });
});

describe('an unchecked row never auto-promotes; the check does', () => {
  test('a complete, plausible identity stays pending while unchecked', async () => {
    const doc = uncheckedDoc();
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
    expect(doc.$locals.promotedFromPending).toBeUndefined();
  });

  test('clearing the flag and validating again promotes through the ordinary hook', async () => {
    const doc = uncheckedDoc();
    await doc.validate();
    doc.uncheckedIdentity = false;
    doc.normalizedKey = generateWineKey(doc.name, doc.producer);
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
    expect(doc.$locals.promotedFromPending).toBe(true);
  });

  test('a checked row with no producer stays pending: it is then an ordinary producerless row', async () => {
    const doc = uncheckedDoc({ producer: '' });
    await doc.validate();
    doc.uncheckedIdentity = false;
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });
});

describe('the unchecked key namespace', () => {
  test('carries the creator, the producer and the name, and cannot be produced by a real producer', () => {
    const key = uncheckedWineKey('Kaefferkopf', 'Cave de Kaysersberg', CREATOR, 'Alsace Grand Cru');
    expect(key).toBe(`${UNCHECKED_KEY_PREFIX}${CREATOR}:cave de kaysersberg:kaefferkopf:alsace grand cru`);
    // '~' never survives normalizeString, so no ordinary key starts with the prefix.
    expect(normalizeString(UNCHECKED_KEY_PREFIX)).not.toContain('~');
  });

  test('two members\' rows of one wine get different keys', () => {
    expect(uncheckedWineKey('Kaefferkopf', 'Cave de Kaysersberg', CREATOR))
      .not.toBe(uncheckedWineKey('Kaefferkopf', 'Cave de Kaysersberg', oid()));
  });
});

describe('the key follows the state, whoever writes it', () => {
  test('a writer that rebuilds the ordinary key on an unchecked row gets the namespaced key back', async () => {
    // The admin wine form, a proposal approval and a report fix all rebuild
    // producer:name:appellation without knowing the row is hidden.
    const doc = uncheckedDoc();
    await doc.validate();
    doc.name = 'Kaefferkopf Riesling';
    doc.normalizedKey = generateWineKey(doc.name, doc.producer);
    await doc.validate();

    expect(doc.pendingIdentity).toBe(true);
    expect(doc.normalizedKey).toBe(uncheckedWineKey('Kaefferkopf Riesling', 'Cave de Kaysersberg', CREATOR));
  });

  test('with no producer it is the pending-namespace key', async () => {
    const doc = uncheckedDoc({ producer: '', normalizedKey: generateWineKey('Kaefferkopf', '') });
    await doc.validate();
    expect(doc.normalizedKey.startsWith(`pending~${CREATOR}:`)).toBe(true);
  });

  test('a row that has left the state does not keep the namespace', async () => {
    const doc = uncheckedDoc();
    await doc.validate();
    doc.uncheckedIdentity = false; // the check, by a writer that forgot the key
    await doc.validate();

    expect(doc.pendingIdentity).toBe(false);
    expect(doc.normalizedKey).toBe(generateWineKey('Kaefferkopf', 'Cave de Kaysersberg'));
  });

  test('an ordinary wine and a draft are left alone', async () => {
    const ordinary = uncheckedDoc({ uncheckedIdentity: false, normalizedKey: generateWineKey('Kaefferkopf', 'Cave de Kaysersberg') });
    await ordinary.validate();
    expect(ordinary.normalizedKey).toBe(generateWineKey('Kaefferkopf', 'Cave de Kaysersberg'));

    const draft = uncheckedDoc({ uncheckedIdentity: false, draft: true, normalizedKey: 'draft~x:cave de kaysersberg:kaefferkopf:' });
    await draft.validate();
    expect(draft.normalizedKey).toBe('draft~x:cave de kaysersberg:kaefferkopf:');
  });
});
