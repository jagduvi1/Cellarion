/**
 * utils/profileReview — the "has a profile" predicate and its Mongo twin must
 * agree on every shape a row can take, or the two somm queues list different
 * wines as unprofiled.
 */
const {
  hasProfileContent, UNPROFILED_QUERY, OUTSTANDING_REVIEW_EXPR, HELD_QUEUE_OUTSTANDING_EXPR,
  PUBLISHED_SUSPECT_UNDECIDED_EXPR, isUndecidedPublishedSuspect, REVIEW_QUEUE_OUTSTANDING_EXPR, isOutstandingInReviewQueue,
} = require('./profileReview');

// A tiny evaluator for the three-field equality/$in query, so the test can
// run the query against the same rows the predicate sees.
function matchesUnprofiledQuery(aiProfile) {
  const ap = aiProfile || {};
  const want = (field, cond) => {
    const value = ap[field] ?? null;
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(value);
    return value === cond;
  };
  return want('generatedAt', UNPROFILED_QUERY['aiProfile.generatedAt'])
    && want('description', UNPROFILED_QUERY['aiProfile.description'])
    && want('body', UNPROFILED_QUERY['aiProfile.body']);
}

const cases = [
  ['no aiProfile at all', undefined, false],
  ['an empty subdoc', {}, false],
  ['an empty-string description and nothing else', { description: '' }, false],
  ['a null description, generatedAt and body', { description: null, generatedAt: null, body: null }, false],
  ['a HELD profile (generatedAt, no prose)', { generatedAt: new Date(), description: null }, true],
  ['a curator profile with prose', { description: 'Firm and long.' }, true],
  ['a prose-less curator profile with a body', { body: 'medium' }, true],
];

test.each(cases)('%s: predicate and query agree (has content: %s)', (_label, aiProfile, hasContent) => {
  expect(hasProfileContent(aiProfile)).toBe(hasContent);
  expect(matchesUnprofiledQuery(aiProfile)).toBe(!hasContent);
});

test('the query and the review expressions are frozen all the way down, so a caller cannot bend one queue without the other', () => {
  expect(Object.isFrozen(UNPROFILED_QUERY)).toBe(true);
  expect(Object.isFrozen(UNPROFILED_QUERY['aiProfile.description'].$in)).toBe(true);
  expect(Object.isFrozen(OUTSTANDING_REVIEW_EXPR.$or[1].$lt)).toBe(true);
  expect(Object.isFrozen(HELD_QUEUE_OUTSTANDING_EXPR.$cond[2].$eq[0].$ifNull)).toBe(true);
});

// In an aggregation expression a missing field is not equal to null. A wine
// stored without the heldAt key must take the published arm, where only an
// explicit verdict closes the question; read bare, it takes the held arm.
test('the held test reads heldAt through $ifNull, and the held arm is the shared review expression', () => {
  expect(HELD_QUEUE_OUTSTANDING_EXPR.$cond[0]).toEqual({ $ne: [{ $ifNull: ['$aiProfile.heldAt', null] }, null] });
  expect(HELD_QUEUE_OUTSTANDING_EXPR.$cond[1]).toBe(OUTSTANDING_REVIEW_EXPR);
  expect(HELD_QUEUE_OUTSTANDING_EXPR.$cond[2]).toEqual({ $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] });
});

// The admin queue's rule and its JavaScript twin. The expression itself is run
// against a real database when it changes; here the twin is pinned case by
// case, and the expression's shape so that a change to one is seen beside the
// other.
describe('the admin review queue: outstanding until reviewed, and a flagged producer until someone rules on it', () => {
  const generatedAt = new Date('2026-07-26T08:00:00Z');
  const before = new Date('2026-07-25T08:00:00Z');
  const after = new Date('2026-07-27T08:00:00Z');
  const wine = (aiProfile, profileReviewedAt = null) => ({ aiProfile: { generatedAt, description: 'd', ...aiProfile }, profileReviewedAt });

  test.each([
    ['never reviewed', wine({}), true],
    ['reviewed before the profile was regenerated', wine({}, before), true],
    ['reviewed since', wine({}, after), false],
    ['a flagged producer, stamped, no verdict', wine({ producerSuspect: true }, after), true],
    ['a flagged producer, upheld', wine({ producerSuspect: true, suspectDecision: 'upheld' }, after), false],
    ['a flagged producer on a HELD profile, stamped', wine({ producerSuspect: true, heldAt: generatedAt }, after), false],
    ['a flagged producer with no prose, stamped', wine({ producerSuspect: true, description: '' }, after), false],
  ])('%s: outstanding %s', (_label, row, outstanding) => {
    expect(isOutstandingInReviewQueue(row)).toBe(outstanding);
  });

  test('the undecided-suspect test reads the four things the expression reads', () => {
    expect(isUndecidedPublishedSuspect({ producerSuspect: true, description: 'd' })).toBe(true);
    expect(isUndecidedPublishedSuspect({ producerSuspect: true, description: 'd', heldAt: generatedAt })).toBe(false);
    expect(isUndecidedPublishedSuspect({ producerSuspect: true, description: 'd', suspectDecision: 'confirmed' })).toBe(false);
    expect(isUndecidedPublishedSuspect({ producerSuspect: true })).toBe(false);
    expect(isUndecidedPublishedSuspect({ producerSuspect: false, description: 'd' })).toBe(false);
    expect(isUndecidedPublishedSuspect(undefined)).toBe(false);
    expect(PUBLISHED_SUSPECT_UNDECIDED_EXPR).toEqual({
      $and: [
        { $eq: [{ $ifNull: ['$aiProfile.heldAt', null] }, null] },
        { $eq: ['$aiProfile.producerSuspect', true] },
        { $gt: [{ $ifNull: ['$aiProfile.description', ''] }, ''] },
        { $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] },
      ],
    });
  });

  test('the queue expression is the review comparison OR the undecided suspect, frozen like the rest', () => {
    expect(REVIEW_QUEUE_OUTSTANDING_EXPR.$or[0]).toBe(OUTSTANDING_REVIEW_EXPR);
    expect(REVIEW_QUEUE_OUTSTANDING_EXPR.$or[1]).toBe(PUBLISHED_SUSPECT_UNDECIDED_EXPR);
    expect(Object.isFrozen(REVIEW_QUEUE_OUTSTANDING_EXPR.$or)).toBe(true);
    expect(Object.isFrozen(PUBLISHED_SUSPECT_UNDECIDED_EXPR.$and[2].$gt)).toBe(true);
  });
});
