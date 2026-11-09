/**
 * utils/profileReview — the "has a profile" predicate and its Mongo twin must
 * agree on every shape a row can take, or the two somm queues list different
 * wines as unprofiled.
 */
const { hasProfileContent, UNPROFILED_QUERY } = require('./profileReview');

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

test('the query is frozen, so a caller cannot bend one queue without the other', () => {
  expect(Object.isFrozen(UNPROFILED_QUERY)).toBe(true);
});
