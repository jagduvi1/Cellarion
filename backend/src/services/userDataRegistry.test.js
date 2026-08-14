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

describe('ReviewVote purge — reconciles Review.likesCount (grand-audit M11)', () => {
  const ReviewVote = require('../models/ReviewVote');
  const Review = require('../models/Review');
  const entry = REGISTRY.find(e => e.model.modelName === 'ReviewVote');
  const ctx = { userId: 'u1', deletedUserId: 'del1' };

  test('decrements likesCount per liked review BEFORE deleting the votes', async () => {
    const findSpy = jest.spyOn(ReviewVote, 'find').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([{ review: 'rev1' }, { review: 'rev1' }, { review: 'rev2' }]) }),
    });
    const bulkSpy = jest.spyOn(Review, 'bulkWrite').mockResolvedValue({});
    const clampSpy = jest.spyOn(Review, 'updateMany').mockResolvedValue({});
    const delSpy = jest.spyOn(ReviewVote, 'deleteMany').mockResolvedValue({});

    await entry.purge(ctx);

    // rev1 had two of the user's likes → -2; rev2 → -1. Guarded by likesCount>=n.
    const ops = bulkSpy.mock.calls[0][0];
    expect(ops).toContainEqual({ updateOne: { filter: { _id: 'rev1', likesCount: { $gte: 2 } }, update: { $inc: { likesCount: -2 } } } });
    expect(ops).toContainEqual({ updateOne: { filter: { _id: 'rev2', likesCount: { $gte: 1 } }, update: { $inc: { likesCount: -1 } } } });
    expect(delSpy).toHaveBeenCalledWith({ user: 'u1' });

    findSpy.mockRestore(); bulkSpy.mockRestore(); clampSpy.mockRestore(); delSpy.mockRestore();
  });

  test('registers recipientEmail on the Recommendation entry (M10)', () => {
    const rec = REGISTRY.find(e => e.model.modelName === 'Recommendation');
    expect(rec.userFields).toContain('recipientEmail');
  });
});

// Owner inquiries are multi-party: one curator question, up to 20 recipient
// owners with answers. Erasure must be surgical — pull ONLY the departing
// user's recipient entry (their answer goes with it), keep the question for
// the others, close the inquiry when nobody is left, and null the asker ref
// (the schema is nullable for exactly this). Export covers both sides.
describe('WineOwnerInquiry — recipient-entry erasure + asker nulling', () => {
  const WineOwnerInquiry = require('../models/WineOwnerInquiry');
  const entry = REGISTRY.find(e => e.model.modelName === 'WineOwnerInquiry');
  const ctx = { userId: 'u1', deletedUserId: 'del1' };

  test('is registered with all three user link fields', () => {
    expect(entry).toBeTruthy();
    expect(entry.userFields).toEqual(expect.arrayContaining(['askedBy', 'recipients.user', 'resolvedBy']));
  });

  test('purge pulls the user\'s recipient entry (answer included), NULLS askedBy, clears resolvedBy', async () => {
    const updateSpy = jest.spyOn(WineOwnerInquiry, 'updateMany').mockResolvedValue({});
    try {
      await Promise.all(entry.purge(ctx));
      const calls = updateSpy.mock.calls;
      // (a) their recipient entry — and with it their answer — leaves the doc
      expect(calls).toContainEqual([
        { 'recipients.user': 'u1' },
        { $pull: { recipients: { user: 'u1' } } },
      ]);
      // (b) inquiries they asked keep the question, anonymous
      expect(calls).toContainEqual([
        { askedBy: 'u1' },
        { $set: { askedBy: null } },
      ]);
      // (c) their admin ref off OTHER users' resolved inquiries
      expect(calls).toContainEqual([
        { resolvedBy: 'u1' },
        { $unset: { resolvedBy: '' } },
      ]);
    } finally {
      updateSpy.mockRestore();
    }
  });

  test('postPurge closes ACTIVE inquiries left with no recipients (nobody can answer any more)', async () => {
    const updateSpy = jest.spyOn(WineOwnerInquiry, 'updateMany').mockResolvedValue({});
    try {
      await entry.postPurge(ctx);
      const [filter, update] = updateSpy.mock.calls[0];
      expect(filter).toEqual({ recipients: { $size: 0 }, status: { $in: ['open', 'answered'] } });
      expect(update.$set.status).toBe('closed');
      // resolvedAt is stamped so the closed shell still rides the 180-day TTL.
      expect(update.$set.resolvedAt).toBeInstanceOf(Date);
    } finally {
      updateSpy.mockRestore();
    }
  });

  test('export returns both sides — own answers with question + wine label, own asked questions — never other recipients', async () => {
    const chain = (rows) => {
      const c = {};
      for (const m of ['select', 'populate', 'limit']) c[m] = jest.fn(() => c);
      c.lean = jest.fn(async () => rows);
      return c;
    };
    const received = [{
      question: 'What does the label say the producer is?', status: 'resolved',
      wineDefinition: { producer: 'Pira', name: 'Barolo' },
      recipients: [
        { user: 'u1', response: 'Label says E. Pira e Figli', respondedAt: 'r1', notifiedAt: 'n1' },
        { user: 'u2', response: 'another owner\'s private answer' },
      ],
      // Correspondence sent TO them — exported. The curator's own
      // resolutionNote is deliberately not even selected on this side.
      ownerReply: 'Thank you — the producer is now recorded as E. Pira e Figli.',
      createdAt: 'c1', resolvedAt: 'r0',
    }];
    const asked = [{
      question: 'Is this the DOCG bottling?', status: 'resolved', resolutionNote: 'Record corrected.',
      wineDefinition: { producer: 'G', name: 'W' }, createdAt: 'c2', resolvedAt: 'r2',
    }];
    const findSpy = jest.spyOn(WineOwnerInquiry, 'find')
      .mockReturnValueOnce(chain(received))
      .mockReturnValueOnce(chain(asked));
    try {
      const frag = await entry.exportFragment({ userId: 'u1', truncated: {} });
      expect(frag.ownerInquiries.received[0]).toEqual({
        wine: 'Pira — Barolo',
        question: 'What does the label say the producer is?',
        status: 'resolved',
        myResponse: 'Label says E. Pira e Figli',
        respondedAt: 'r1',
        notifiedAt: 'n1',
        curatorReply: 'Thank you — the producer is now recorded as E. Pira e Figli.',
        createdAt: 'c1',
        resolvedAt: 'r0',
      });
      // Portability is the USER's data only — the co-recipient's answer must not ride along.
      expect(JSON.stringify(frag)).not.toContain('another owner');
      expect(frag.ownerInquiries.asked[0]).toMatchObject({
        wine: 'G — W',
        question: 'Is this the DOCG bottling?',
        resolutionNote: 'Record corrected.',
        resolvedAt: 'r2',
      });
    } finally {
      findSpy.mockRestore();
    }
  });
});
