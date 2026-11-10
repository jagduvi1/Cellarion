// Held-profile decisions: the body behind the MCP review_held_profile tool
// (mcp/tools/somm/heldProfiles.js), one wine at a time, shared by its single
// and batch paths so the semantics and the stamp rule cannot fork.
//
// A generated tasting profile is HELD unpublished by the publication gate
// (services/enrichmentJob) for a stated reason, or PUBLISHED with a doubt
// flag on the producer. Four verbs settle such a row:
//   release  held rows only — the doubt was unfounded; the profile REGENERATES
//            under the human override and publishes (one AI call). Refused
//            while automatic AI profiles are off: set_wine_profile is the way.
//   confirm  the current state is correct — a held row stays held and leaves
//            the queue; a published row keeps its profile and its doubt flags
//            are cleared (a human adjudicated them), the producer note with
//            them, and a rule tag that moved it out of the suspect queue.
//   uphold   published rows only — the flag is CORRECT; the row keeps flag and
//            caveat and leaves the queue as honest residue.
//   reject   held rows only — the generation is garbage; the profile clears
//            and the wine returns to the enrichment pool. The curator's
//            serving trait is not part of the generation and stays.
// Every path settles the held or flagged state: release/confirm/uphold stamp
// profileReviewedAt, reject clears the generation itself (the wine is then
// listed as "unprofiled", awaiting a first profile). The suspect verdict is
// recorded in its own field (suspectDecision), because a curator profile
// write also stamps profileReviewedAt and must not close a question nobody
// answered.
//
// The web twin, POST /api/admin/wines/:id/profile-reviewed, keeps a simpler
// contract (a held row is released without waiting, any other row is stamped
// as reviewed with no flag change), pinned by routes/admin/
// wines.lowConfidence.test.js; aligning the two is its own decision.
//
// This module stays free of the MCP envelope: it returns plain result objects
// ({ wine_id, label, decision, ... } or { wine_id, error }) that the tool
// words for the caller.

const WineDefinition = require('../models/WineDefinition');
const aiConfig = require('../config/aiConfig');
const { logAudit } = require('./audit');

/**
 * The fields a decision reads; producerNote is included so confirm can clear
 * it, and the serving trait so reject can carry it over.
 */
const DECISION_SELECT = 'name producer aiProfile.heldAt aiProfile.heldReason aiProfile.producerSuspect aiProfile.producerUnknown aiProfile.suspectDowngradedBy aiProfile.producerNote aiProfile.description aiProfile.servingTempMin aiProfile.servingTempMax aiProfile.needsAir';

const DECISIONS = ['release', 'confirm', 'uphold', 'reject'];
/** A curator's serving trait: set by hand, never generated, so a rejected generation does not take it along. */
const SERVING_FIELDS = ['servingTempMin', 'servingTempMax', 'needsAir'];

/** A rejected generation: the aiProfile subdoc as a fresh, re-enrichable blank. */
const CLEARED_PROFILE = Object.freeze({
  body: null, tannin: null, acidity: null, sweetness: null,
  flavors: [], foodPairings: [], description: null,
  confidence: null, producerSuspect: false, producerUnknown: false,
  producerNote: null, model: null, source: 'ai',
  generatedAt: null, heldAt: null, heldReason: null,
});

/**
 * Decide one wine. `reason` and `context` arrive already sanitised and
 * bounded by the caller (context only matters to release). Returns a result
 * object; errors are reported as `{ wine_id, error }` strings the caller maps
 * to its own refusal codes, never thrown, so a batch can continue.
 */
async function decideHeldProfile(id, decision, { reason = null, context = null, req, via } = {}) {
  // Refused before any read: the last branch below clears a profile, and an
  // unknown verb must never fall through to it.
  if (!DECISIONS.includes(decision)) return { wine_id: id, error: 'invalid_decision' };
  const wine = await WineDefinition.findById(id).select(DECISION_SELECT);
  if (!wine) return { wine_id: id, error: 'not_found' };
  const ap = wine.aiProfile || {};
  const held = !!ap.heldAt;
  const flaggedPublished = !held && ap.producerSuspect === true && !!ap.description;
  // producerUnknown-only rows are confirmable too: a documented estate can
  // carry the flag, and no other verb clears it — set_wine_profile writes the
  // profile, not the doubt fields.
  const unknownOnly = !held && !flaggedPublished && ap.producerUnknown === true;
  // …and so are rows a RULE moved out of the suspect queue: such a rule lands
  // a row CLEAN — no flag at all, only the rule tag — so confirm is where a
  // curator who then placed the producer says so, and it is
  // list_rule_downgrades' exit.
  const ruleDowngraded = !held && !flaggedPublished && !unknownOnly && !!ap.suspectDowngradedBy;
  const confirmable = (unknownOnly || ruleDowngraded) && decision === 'confirm';
  if (!held && !flaggedPublished && !confirmable) {
    return { wine_id: id, error: 'nothing_to_review' };
  }
  const label = `${wine.name} — ${wine.producer}`;
  const door = via ? { via } : {};

  if (decision === 'release') {
    if (!held) return { wine_id: id, error: 'already_published — use confirm, or set_wine_profile to correct' };
    // Somm-owned wine data (enrichmentOnAdd 'off'): the AI writes no profile,
    // and a release IS a profile write — a forced regeneration. Refused with
    // the way out rather than performed; the curator's own set_wine_profile
    // replaces the held text and clears the hold
    // (services/wineProfileOps.applyProfilePatch).
    if (aiConfig.get().enrichmentOnAdd === 'off') {
      return { wine_id: id, error: 'ai_profiles_off — automatic AI profiles are switched off on this server, so a held profile is not regenerated; write it with set_wine_profile (that replaces the held one and clears the hold)' };
    }
    const { releaseHeldProfile } = require('./enrichmentJob');
    const published = await releaseHeldProfile(wine._id, { context });
    if (!published) return { wine_id: id, error: 'generation_failed — row stays queued; retry or set_wine_profile' };
    // releaseHeldProfile stamps profileReviewedAt INSIDE its success path —
    // the stamp-on-release rule that keeps released rows out of the queue.
    logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, heldRelease: true, decision: 'release', reason, withContext: !!context, ...door });
    return { wine_id: wine._id, label, decision: 'release', published: true };
  }

  if (decision === 'confirm') {
    const now = new Date();
    const set = { profileReviewedAt: now };
    // Confirming a PUBLISHED suspect row means a human adjudicated the doubt
    // and kept the row — so the owner-visible caveat must go, or a documented
    // domaine keeps a false "cannot be verified" disclaimer after review.
    if (!held) {
      if (flaggedPublished) {
        set['aiProfile.producerSuspect'] = false;
        // Record the verdict, not just its side effect: the decision is worth
        // counting on its own, and it keeps confirm and uphold symmetrical.
        set['aiProfile.suspectDecision'] = 'confirmed';
        set['aiProfile.suspectDecidedAt'] = now;
      }
      // confirm also clears producerUnknown when set: the curator is saying
      // "I have placed this producer", which is that flag's exact negation.
      // No suspectDecision stamp on an unknown-only row: that field is the
      // verdict on producerSuspect, and ONLY that.
      if (ap.producerUnknown === true) set['aiProfile.producerUnknown'] = false;
      // A human placement replaces the rule's residue: the tag is what keeps
      // a row in list_rule_downgrades, and the curator has now done the
      // review that list exists to invite. Which rule fired is kept in the
      // audit row below.
      if (ap.suspectDowngradedBy) set['aiProfile.suspectDowngradedBy'] = null;
      // …and the NOTE goes with the flag it explains: once a human has
      // adjudicated the doubt, the model's account of it has no remaining
      // audience, and where the note asserts something false it would outlive
      // the flag that qualified it. Scoped to a flag actually clearing: a
      // confirm on a HELD row keeps the row held, so the doubt is unresolved
      // and the note is still live context. The note is copied into the audit
      // detail rather than dropped silently.
      if ((flaggedPublished || ap.producerUnknown === true) && ap.producerNote) {
        set['aiProfile.producerNote'] = null;
      }
    }
    await WineDefinition.updateOne({ _id: wine._id }, { $set: set });
    const state = held ? 'held'
      : flaggedPublished ? 'published_suspect'
        : ap.producerUnknown === true ? 'published_unknown'
          : 'published_rule_downgraded';
    const noteCleared = set['aiProfile.producerNote'] === null ? ap.producerNote : null;
    const cleared = {
      ...(flaggedPublished ? { suspectCleared: true } : {}),
      ...(!held && ap.producerUnknown === true ? { unknownCleared: true } : {}),
      ...(!held && ap.suspectDowngradedBy ? { ruleCleared: ap.suspectDowngradedBy } : {}),
    };
    logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
      {
        name: wine.name, producer: wine.producer, decision: 'confirm', state, ...cleared,
        // The cleared note, preserved where it can still be read. Bounded:
        // an audit detail is not a place to store an essay.
        ...(noteCleared ? { clearedProducerNote: String(noteCleared).slice(0, 500) } : {}),
        reason, ...door,
      });
    return {
      wine_id: wine._id, label, decision: 'confirm', state,
      ...(cleared.suspectCleared ? { suspect_cleared: true } : {}),
      ...(cleared.unknownCleared ? { unknown_cleared: true } : {}),
      ...(cleared.ruleCleared ? { rule_cleared: cleared.ruleCleared, left_rule_downgrades: true } : {}),
      // Told, not silent: the curator should know the caveat went with the
      // flag, because they can no longer see it to check.
      ...(noteCleared ? { producer_note_cleared: true } : {}),
      reviewed_at: now,
    };
  }

  if (decision === 'uphold') {
    // The flag is CORRECT, so the row needs a queue-clearing verb that does
    // not damage the data (confirm clears the flag). Uphold keeps flag,
    // caveat and published state, stamps reviewed, and the row leaves the
    // queue as honest residue — upheld-count is the true cannot-identify number.
    if (held) return { wine_id: id, error: 'uphold_is_published_only — for a held row whose flag is right, confirm keeps it held' };
    const now = new Date();
    // suspectDecision is what closes the row; profileReviewedAt rides along
    // because it still means "a human looked" for the other queues.
    await WineDefinition.updateOne({ _id: wine._id }, {
      $set: {
        profileReviewedAt: now,
        'aiProfile.suspectDecision': 'upheld',
        'aiProfile.suspectDecidedAt': now,
      },
    });
    logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, decision: 'uphold', suspectKept: true, reason, ...door });
    return { wine_id: wine._id, label, decision: 'uphold', suspect_kept: true, reviewed_at: now };
  }

  // reject — held rows only: nothing published means nothing embedded, so a
  // full clear needs no vector cleanup. A published row wanting removal is a
  // different operation (set_wine_profile, or an identity fix).
  if (!held) return { wine_id: id, error: 'reject_is_held_only — for a published profile, set_wine_profile, confirm (clears the flag) or uphold (keeps it)' };
  const now = new Date();
  // The write replaces the whole subdocument, so what must survive the clear
  // is carried over by name.
  const serving = {};
  for (const f of SERVING_FIELDS) {
    if (ap[f] !== null && ap[f] !== undefined) serving[f] = ap[f];
  }
  await WineDefinition.updateOne(
    { _id: wine._id },
    { $set: { aiProfile: { ...CLEARED_PROFILE, flavors: [], foodPairings: [], ...serving }, updatedAt: now } }
  );
  logAudit(req, 'somm.profile.rejectHeld', { type: 'wine', id: wine._id },
    { name: wine.name, producer: wine.producer, previousReason: ap.heldReason || null, reason, ...door });
  return { wine_id: wine._id, label, decision: 'reject', requeued_for_enrichment: true };
}

module.exports = { DECISION_SELECT, decideHeldProfile };
