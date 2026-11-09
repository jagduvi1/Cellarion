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

module.exports = { hasProfileContent, UNPROFILED_QUERY };
