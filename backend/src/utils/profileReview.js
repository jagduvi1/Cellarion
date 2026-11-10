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
 * description; a prose-less curator profile may carry body/flavors without
 * prose. Neither is "nothing describes the wine".
 *
 * Callers: profileLite and set_vintage_maturity's courtesy warning in
 * mcp/tools/somm.js, and list_held_profiles' state labelling. UNPROFILED_QUERY
 * below is this test written as a query.
 *
 * @param {object} ap  aiProfile subdoc (lean or hydrated)
 */
const hasProfileContent = (ap) => !!(ap && (ap.generatedAt || ap.description || ap.body));

/**
 * The rows for which hasProfileContent is false: never generated, no
 * description (null or the empty string the predicate also reads as absent),
 * no body. Pass it as the whole filter or as one $or branch.
 */
const UNPROFILED_QUERY = Object.freeze({
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
const OUTSTANDING_REVIEW_EXPR = Object.freeze({
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
 */
const HELD_QUEUE_OUTSTANDING_EXPR = Object.freeze({
  $cond: [
    { $ne: ['$aiProfile.heldAt', null] },
    OUTSTANDING_REVIEW_EXPR,
    { $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] },
  ],
});

module.exports = { hasProfileContent, UNPROFILED_QUERY, OUTSTANDING_REVIEW_EXPR, HELD_QUEUE_OUTSTANDING_EXPR };
