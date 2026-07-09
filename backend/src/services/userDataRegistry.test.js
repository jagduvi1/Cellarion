/**
 * Guards the GDPR user-data registry against silent drift.
 *
 * The key test enumerates every model file and fails if any model that
 * references User is neither registered (purge/export) nor explicitly excluded
 * with a reason — so adding a new user-linked model can't slip through without
 * a conscious decision about erasure + portability.
 */
// services/search.js eagerly requires the ESM-only `meilisearch` package,
// which Jest can't parse — mock it (same pattern as cellarImport.test.js).
jest.mock('./search', () => ({
  removeBottles: jest.fn(),
  indexDiscussion: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { REGISTRY, EXCLUDED, registeredModelNames } = require('./userDataRegistry');
const DiscussionReply = require('../models/DiscussionReply');
const AuditLog = require('../models/AuditLog');

describe('userDataRegistry', () => {
  const modelsDir = path.join(__dirname, '..', 'models');
  const modelFiles = fs.readdirSync(modelsDir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

  test('every model with a ref:User is registered or explicitly excluded', () => {
    const covered = new Set([...registeredModelNames(), ...Object.keys(EXCLUDED)]);
    const missing = [];
    for (const file of modelFiles) {
      const name = file.replace(/\.js$/, '');
      const src = fs.readFileSync(path.join(modelsDir, file), 'utf8');
      const hasUserRef = /ref:\s*['"]User['"]/.test(src);
      if (hasUserRef && !covered.has(name)) missing.push(name);
    }
    // If this fails: add the model to REGISTRY (with purge + export) or to
    // EXCLUDED (with a reason) in services/userDataRegistry.js.
    expect(missing).toEqual([]);
  });

  test('no model is both registered and excluded', () => {
    const excludedNames = Object.keys(EXCLUDED);
    const overlap = registeredModelNames().filter(n => excludedNames.includes(n));
    expect(overlap).toEqual([]);
  });

  test('every registry entry has a model and either a handler or a documented note', () => {
    for (const e of REGISTRY) {
      expect(e.model && e.model.modelName).toBeTruthy();
      const hasHandler = !!e.purge || !!e.exportFragment;
      expect(hasHandler || !!e.note).toBe(true);
    }
  });

  test('every EXCLUDED entry has a non-empty reason', () => {
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('AuditLog is handled and anonymises the actor (incl. ipAddress field path)', () => {
    const audit = REGISTRY.find(e => e.model.modelName === 'AuditLog');
    expect(audit).toBeTruthy();
    expect(audit.userFields).toContain('actor.userId');
    expect(typeof audit.purge).toBe('function');
  });

  test('registry model names are unique', () => {
    const names = registeredModelNames();
    expect(new Set(names).size).toBe(names.length);
  });

  // L-15: cellar-sharing audit events embed the invitee's email in the
  // free-form detail — the erasure scrub must blank those too.
  test('AuditLog purge scrubs detail.sharedWith and detail.invitedEmail (L-15)', async () => {
    const audit = REGISTRY.find(e => e.model.modelName === 'AuditLog');
    const updateSpy = jest.spyOn(AuditLog, 'updateMany').mockResolvedValue({});

    try {
      await audit.purge({ userId: 'u1', deletedUserId: 'del1' });
      expect(updateSpy).toHaveBeenCalledWith(
        { 'actor.userId': 'u1' },
        expect.objectContaining({
          $set: { 'actor.userId': null, 'actor.ipAddress': null },
          $unset: expect.objectContaining({
            'detail.email': '',
            'detail.username': '',
            'detail.sharedWith': '',
            'detail.invitedEmail': '',
          }),
        })
      );
    } finally {
      updateSpy.mockRestore();
    }
  });
});

// L-17: a deleted user's display name must not survive erasure inside OTHER
// users' reply quotes. The purge scrubs quote.authorName by quote.authorId,
// and resolves legacy quotes (no authorId) through quote.replyId → the user's
// own reply ids.
describe('DiscussionReply purge — quote.authorName erasure (L-17)', () => {
  const entry = REGISTRY.find(e => e.model.modelName === 'DiscussionReply');
  const ctx = { userId: 'u1', deletedUserId: 'del1' };

  let distinctSpy;
  let updateSpy;

  beforeEach(() => {
    distinctSpy = jest.spyOn(DiscussionReply, 'distinct').mockResolvedValue(['r1', 'r2']);
    updateSpy = jest.spyOn(DiscussionReply, 'updateMany').mockResolvedValue({});
  });

  afterEach(() => {
    distinctSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('registers quote.authorId as a user field', () => {
    expect(entry.userFields).toContain('quote.authorId');
  });

  test('re-points own replies AND anonymises quotes of the departing user', async () => {
    await entry.purge(ctx);

    // Own reply ids are collected BEFORE the author re-point (legacy quotes
    // are resolvable only while author still equals the departing user).
    expect(distinctSpy).toHaveBeenCalledWith('_id', { author: 'u1' });

    const calls = updateSpy.mock.calls;
    // 1) own replies re-pointed to the [deleted] sentinel
    expect(calls).toContainEqual([
      { author: 'u1' },
      { $set: { author: 'del1' } },
    ]);
    // 2) quotes carrying the user's id: name scrubbed, id re-pointed
    expect(calls).toContainEqual([
      { 'quote.authorId': 'u1' },
      { $set: { 'quote.authorName': '[deleted]', 'quote.authorId': 'del1' } },
    ]);
    // 3) legacy quotes (no authorId) resolved via the user's own reply ids
    expect(calls).toContainEqual([
      { 'quote.authorId': null, 'quote.replyId': { $in: ['r1', 'r2'] } },
      { $set: { 'quote.authorName': '[deleted]' } },
    ]);
  });
});
