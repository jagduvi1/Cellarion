/**
 * services/heldProfileOps — the one-wine decision behind review_held_profile.
 * mcp/sommTools.test.js pins the tool's wording and batching; this file pins
 * the decision itself: which rows each verb accepts, what it writes, and
 * what it audits.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({})) }));
jest.mock('./enrichmentJob', () => ({ releaseHeldProfile: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const aiConfig = require('../config/aiConfig');
const { releaseHeldProfile } = require('./enrichmentJob');
const { logAudit } = require('./audit');
const { decideHeldProfile, DECISION_SELECT } = require('./heldProfileOps');

const wine = (aiProfile) => ({ _id: 'w1', name: 'Crianza', producer: 'Finca X', aiProfile });
const held = (over = {}) => wine({ heldAt: new Date('2026-08-18'), heldReason: 'low_confidence', generatedAt: new Date('2026-08-17'), ...over });
const publishedSuspect = (over = {}) => wine({ heldAt: null, producerSuspect: true, description: 'x', generatedAt: new Date(), ...over });
const load = (doc) => WineDefinition.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
const REQ = { id: 'req' };

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.get.mockReturnValue({});
});

test('loads the fields the decision reads, producerNote included, and reports an unknown wine', async () => {
  load(null);
  expect(await decideHeldProfile('w1', 'confirm', { req: REQ })).toEqual({ wine_id: 'w1', error: 'not_found' });
  expect(WineDefinition.findById.mock.results[0].value.select).toHaveBeenCalledWith(DECISION_SELECT);
  expect(DECISION_SELECT).toMatch(/aiProfile\.producerNote/);
});

test('a published row with nothing held, flagged, unknown or rule-tagged is nothing to review', async () => {
  load(publishedSuspect({ producerSuspect: false }));
  expect(await decideHeldProfile('w1', 'confirm', { req: REQ })).toEqual({ wine_id: 'w1', error: 'nothing_to_review' });
  expect(WineDefinition.updateOne).not.toHaveBeenCalled();
});

describe('release', () => {
  test('regenerates a held row with the curator context, audits with the door, and reports published', async () => {
    load(held());
    releaseHeldProfile.mockResolvedValueOnce(true);
    const out = await decideHeldProfile('w1', 'release', { reason: 'documented estate', context: 'Hunter Valley', req: REQ, via: 'mcp' });
    expect(releaseHeldProfile).toHaveBeenCalledWith('w1', { context: 'Hunter Valley' });
    expect(out).toEqual({ wine_id: 'w1', label: 'Crianza — Finca X', decision: 'release', published: true });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'admin.wine.profileReviewed', { type: 'wine', id: 'w1' },
      { name: 'Crianza', producer: 'Finca X', heldRelease: true, decision: 'release', reason: 'documented estate', withContext: true, via: 'mcp' });
  });

  test('a failed generation leaves the row queued; a published row and a server with AI profiles off are refused before any AI call', async () => {
    load(held());
    releaseHeldProfile.mockResolvedValueOnce(false);
    expect((await decideHeldProfile('w1', 'release', { req: REQ })).error).toMatch(/^generation_failed/);
    expect(logAudit).not.toHaveBeenCalled();

    load(publishedSuspect());
    expect((await decideHeldProfile('w1', 'release', { req: REQ })).error).toMatch(/^already_published/);

    aiConfig.get.mockReturnValue({ enrichmentOnAdd: 'off' });
    load(held());
    expect((await decideHeldProfile('w1', 'release', { req: REQ })).error).toMatch(/^ai_profiles_off.*set_wine_profile/);
    expect(releaseHeldProfile).toHaveBeenCalledTimes(1);
  });
});

describe('confirm', () => {
  test('on a held row: stamps reviewed only, keeps the hold, the note and records no suspect verdict', async () => {
    load(held({ producerNote: 'unclear' }));
    const out = await decideHeldProfile('w1', 'confirm', { req: REQ, via: 'mcp' });
    const [filter, update] = WineDefinition.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'w1' });
    expect(Object.keys(update.$set)).toEqual(['profileReviewedAt']);
    expect(out).toMatchObject({ decision: 'confirm', state: 'held' });
    expect(out.producer_note_cleared).toBeUndefined();
    expect(logAudit.mock.calls[0][3]).toMatchObject({ decision: 'confirm', state: 'held', via: 'mcp' });
    expect(logAudit.mock.calls[0][3].clearedProducerNote).toBeUndefined();
  });

  test('on a published suspect: clears the flag, records the verdict, clears the note into the audit row', async () => {
    load(publishedSuspect({ producerNote: 'a branded line' }));
    const out = await decideHeldProfile('w1', 'confirm', { reason: 'estate verified', req: REQ });
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({ 'aiProfile.producerSuspect': false, 'aiProfile.suspectDecision': 'confirmed', 'aiProfile.producerNote': null });
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
    expect(update.$set['aiProfile.suspectDecidedAt']).toBeInstanceOf(Date);
    expect(out).toMatchObject({ state: 'published_suspect', suspect_cleared: true, producer_note_cleared: true });
    expect(logAudit.mock.calls[0][3]).toMatchObject({ suspectCleared: true, clearedProducerNote: 'a branded line', reason: 'estate verified' });
    expect(logAudit.mock.calls[0][3].via).toBeUndefined();
  });

  test('on an unknown-only row: clears producerUnknown and the note, no suspect verdict', async () => {
    load(publishedSuspect({ producerSuspect: false, producerUnknown: true, producerNote: 'cannot place' }));
    const out = await decideHeldProfile('w1', 'confirm', { req: REQ });
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set['aiProfile.producerUnknown']).toBe(false);
    expect(update.$set['aiProfile.producerNote']).toBeNull();
    expect(update.$set['aiProfile.suspectDecision']).toBeUndefined();
    expect(out).toMatchObject({ state: 'published_unknown', unknown_cleared: true, producer_note_cleared: true });
  });

  test('on a rule-downgraded row: records the placement, clears the tag and names it', async () => {
    load(publishedSuspect({ producerSuspect: false, suspectDowngradedBy: 'note_doubts_cuvee_not_producer' }));
    const out = await decideHeldProfile('w1', 'confirm', { req: REQ });
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set['aiProfile.suspectDowngradedBy']).toBeNull();
    expect(out).toMatchObject({ state: 'published_rule_downgraded', rule_cleared: 'note_doubts_cuvee_not_producer', left_rule_downgrades: true });
    expect(logAudit.mock.calls[0][3]).toMatchObject({ ruleCleared: 'note_doubts_cuvee_not_producer' });
  });
});

describe('uphold', () => {
  test('on a published suspect: records the verdict, stamps reviewed, keeps flag and note', async () => {
    load(publishedSuspect({ producerNote: 'genuinely unidentifiable' }));
    const out = await decideHeldProfile('w1', 'uphold', { req: REQ, via: 'mcp' });
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set).toEqual({
      profileReviewedAt: expect.any(Date), 'aiProfile.suspectDecision': 'upheld', 'aiProfile.suspectDecidedAt': expect.any(Date),
    });
    expect(out).toMatchObject({ decision: 'uphold', suspect_kept: true });
    expect(logAudit.mock.calls[0][3]).toMatchObject({ decision: 'uphold', suspectKept: true, via: 'mcp' });
  });

  test('is refused on a held row and on a rule-downgraded row without a flag', async () => {
    load(held());
    expect((await decideHeldProfile('w1', 'uphold', { req: REQ })).error).toMatch(/^uphold_is_published_only/);
    load(publishedSuspect({ producerSuspect: false, suspectDowngradedBy: 'note_epistemic_only' }));
    expect((await decideHeldProfile('w1', 'uphold', { req: REQ })).error).toBe('nothing_to_review');
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  test('clears a held generation entirely and audits the previous reason; a published row is refused', async () => {
    load(held({ heldReason: 'producer_suspect' }));
    const out = await decideHeldProfile('w1', 'reject', { reason: 'garbage', req: REQ, via: 'mcp' });
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set.aiProfile).toMatchObject({ generatedAt: null, heldAt: null, heldReason: null, description: null, producerSuspect: false, source: 'ai', flavors: [], foodPairings: [] });
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(out).toEqual({ wine_id: 'w1', label: 'Crianza — Finca X', decision: 'reject', requeued_for_enrichment: true });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'somm.profile.rejectHeld', { type: 'wine', id: 'w1' },
      { name: 'Crianza', producer: 'Finca X', previousReason: 'producer_suspect', reason: 'garbage', via: 'mcp' });

    load(publishedSuspect());
    expect((await decideHeldProfile('w1', 'reject', { req: REQ })).error).toMatch(/^reject_is_held_only/);
  });
});
