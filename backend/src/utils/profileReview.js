// The one answer to "does this wine have a tasting profile?", in both forms
// the code needs: a JavaScript predicate for a loaded row and the Mongo query
// for the rows that have none. They are kept side by side so they cannot
// drift: an empty description counts the same in list_maturity_queue
// (unprofiled:true) and in list_held_profiles (state "unprofiled").
//
// Require-free on purpose: route, service, MCP tool and test code all read it.

/**
 * Does a stored profile EXIST — by content, not by who wrote it.
 *
 * generatedAt is the AI's stamp: a profile a curator wrote from scratch never
 * has one, so testing generatedAt alone reports it as absent, and a queue that
 * tested it would call it blank — with a reason string that instructs the
 * curator to write one. Following it in good faith overwrites another curator's
 * research and restamps it as their own. A HELD profile has generatedAt but no
 * description; a prose-less curator profile carries a body without prose.
 * Neither is "nothing describes the wine". The test reads three fields only:
 * a profile holding nothing but tannin or flavors still counts as absent.
 *
 * Callers: profileLite (mcp/tools/somm/shared.js), set_vintage_maturity's
 * courtesy warning (mcp/tools/somm/maturity.js) and list_held_profiles' state
 * labelling (mcp/tools/somm/heldProfiles.js). UNPROFILED_QUERY below is this
 * test written as a query.
 *
 * @param {object} ap  aiProfile subdoc (lean or hydrated)
 */
const hasProfileContent = (ap) => !!(ap && (ap.generatedAt || ap.description || ap.body));

/** Object.freeze all the way down: these constants are shared by every request. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * The rows for which hasProfileContent is false: never generated, no
 * description (null or the empty string the predicate also reads as absent),
 * no body. Pass it as the whole filter or as one $or branch.
 */
const UNPROFILED_QUERY = deepFreeze({
  'aiProfile.generatedAt': null,
  'aiProfile.description': { $in: [null, ''] },
  'aiProfile.body': null,
});

/**
 * "No human has reviewed this profile since it was generated": the $expr
 * clause the admin low-confidence queue, the registry-health counts and the
 * held-profile queue all filter by. A re-enrichment bumps generatedAt past
 * the review and the row re-surfaces by comparison alone, so there is
 * nothing to clear on later edits.
 */
const OUTSTANDING_REVIEW_EXPR = deepFreeze({
  $or: [
    { $eq: ['$profileReviewedAt', null] },
    { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
  ],
});

/**
 * What the held-profile queue (list_held_profiles) still needs judged. Its
 * two states answer DIFFERENT questions, so they cannot share a marker:
 *
 *   HELD          — "is this generated profile publishable?" profileReviewedAt
 *                   is the right signal: any human write to the profile
 *                   answers it, which is why applyProfilePatch stamps it.
 *   PUBLISHED     — "is the producer field real?" A tasting-profile write does
 *   SUSPECT         NOT answer that, yet it stamps profileReviewedAt, so that
 *                   stamp must not take the row out of this queue. Only an
 *                   explicit uphold/confirm (suspectDecision) closes it.
 *
 * In an aggregation expression a MISSING field is not equal to null, unlike in
 * a query. A wine stored without the profile fields has no heldAt key at all,
 * so the held test reads it through $ifNull: read bare, such a row takes the
 * held arm, where a profile write closes it, and its producer question is
 * never listed.
 */
const HELD_QUEUE_OUTSTANDING_EXPR = deepFreeze({
  $cond: [
    { $ne: [{ $ifNull: ['$aiProfile.heldAt', null] }, null] },
    OUTSTANDING_REVIEW_EXPR,
    { $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] },
  ],
});

module.exports = { hasProfileContent, UNPROFILED_QUERY, OUTSTANDING_REVIEW_EXPR, HELD_QUEUE_OUTSTANDING_EXPR };
