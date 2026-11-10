// Wine merge machinery: what happens to everything that references a wine
// when it is merged into another one. One body for every caller:
//   - POST /api/admin/wines/:id/merge and the correction-proposal approve
//     (routes/admin/wineProposals.js) run performWineMerge;
//   - the golden-record POST /api/admin/wines/merge composes the parts itself
//     (reassignWineRefs per source, inheritAiProfile, reembedKeeper);
//   - attaching a private draft to an existing wine (services/wineDraftOps)
//     re-points the draft's references with reassignWineRefs;
//   - the admin wine delete and the not-wine quarantine drop the vectors
//     with purgeSourceVectors.
// routes/admin/wines.js re-exports performWineMerge, inheritAiProfile and
// reassignWineRefs: that is the path those callers and their tests require.
//
// A model that references WineDefinition is moved or dropped in
// reassignWineRefs and listed in utils/wineRefs.js;
// routes/admin/wines.merge.test.js checks that each listed model is touched.
//
// This module stays free of Express: `req` is passed for audit attribution.

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const DeletedBottle = require('../models/DeletedBottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineReport = require('../models/WineReport');
const Review = require('../models/Review');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const WineEmbedding = require('../models/WineEmbedding');
const WineNotDuplicate = require('../models/WineNotDuplicate');
const WineList = require('../models/WineList');
const WishlistItem = require('../models/WishlistItem');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const CommunityWinePrice = require('../models/CommunityWinePrice');
const JournalEntry = require('../models/JournalEntry');
const Recommendation = require('../models/Recommendation');
const RestockAlert = require('../models/RestockAlert');
const WineRequest = require('../models/WineRequest');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const RegistryDataValue = require('../models/RegistryDataValue');
const { bumpDataVersion } = require('./dataVersion');
// Pending correction proposals close with their wine THROUGH this service, so
// a user who filed one is told what happened (it owns the model access).
const { closePendingForWine } = require('./wineCorrectionNotify');
const { repointInquiriesForWineMerge } = require('./ownerInquiryOps');
const { embedSinglePair } = require('./embeddingJob');
const searchService = require('./search');
const { logAudit } = require('./audit');

// The single-pair merge body, so the correction-proposal approve
// (routes/admin/wineProposals.js) runs EXACTLY the machinery
// POST /api/admin/wines/:id/merge runs — one implementation, two callers.
// Ids must be pre-validated (24-hex)
// by the caller; a source that IS the target is refused here, for every
// caller. `req` is for audit attribution only.
// Returns { error: { status, message } } or { bottlesMoved, imageAction,
// source, target }.
async function performWineMerge(sourceId, targetId, req) {
  let [source, target] = await Promise.all([
    WineDefinition.findById(sourceId),
    WineDefinition.findById(targetId),
  ]);
  // Neither side of a merge may be a user's private draft (draft design
  // 2026-09-12): a draft is published or attached by its creator, never merged.
  if (source && source.draft === true) source = null;
  if (target && target.draft === true) target = null;
  if (!source) return { error: { status: 404, message: 'Source wine not found' } };
  if (!target) return { error: { status: 404, message: 'Target wine not found' } };
  // Merging a wine into itself would drop its profiles, price-tracking rows
  // and vectors as "collisions" and then delete it under its own bottles.
  // Compared on the loaded ids, so no spelling of the request ids gets past.
  if (String(source._id) === String(target._id)) {
    return { error: { status: 400, message: 'Cannot merge a wine into itself' } };
  }

  // Capture the source's primary BottleImage (the one whose URL backs
  // WineDefinition.image) BEFORE the bulk reassign below. After reassign
  // it'll point to target, so we need its _id now to decide what to do
  // with the assignedToWine flag.
  const sourcePrimaryImage = await BottleImage.findOne({
    wineDefinition: sourceId,
    assignedToWine: true,
  }).select('_id processedUrl originalUrl');

  // Reassign every reference from source to target (shared with the golden
  // /merge route so both stay in lockstep — one place to add new models).
  const bottlesMoved = await reassignWineRefs(sourceId, targetId);

  // Image consolidation. Contract elsewhere in the codebase (admin/images.js
  // approval flow) is: a wine has at most one BottleImage with
  // assignedToWine: true, and its URL is denormalised into WineDefinition.image.
  // After the bulk reassign above, two things can be broken:
  //   1. Target had no image but source did → target.image still null even
  //      though the source's primary BottleImage is now sitting on target.
  //   2. Target had its own image AND source had a primary image → two
  //      BottleImages now point to target with assignedToWine: true.
  let imageAction = 'none';
  if (sourcePrimaryImage) {
    if (!target.image) {
      // Case 1: adopt the source's primary image as target's
      const sourceUrl = sourcePrimaryImage.processedUrl || sourcePrimaryImage.originalUrl;
      await WineDefinition.findByIdAndUpdate(targetId, {
        image: sourceUrl,
        imageCredit: source.imageCredit || null,
        // Atomic writes skip the save hook; the Bridge's change check reads updatedAt.
        updatedAt: new Date(),
      });
      imageAction = 'adopted_from_source';
    } else {
      // Case 2: target keeps its own image; clear the source's
      // assigned-to-wine flag so we don't have two primaries
      await BottleImage.findByIdAndUpdate(sourcePrimaryImage._id, {
        assignedToWine: false,
      });
      imageAction = 'cleared_source_assignment';
    }
  }

  // Carry the source's tasting profile to the keeper when the keeper has none,
  // or when only the source's was reviewed by a curator — so the re-embed
  // below encodes taste/style instead of losing it on merge.
  await inheritAiProfile(target, [source]);

  logAudit(req, 'admin.wine.merge',
    { type: 'wine', id: source._id },
    {
      sourceName: source.name,
      sourceProducer: source.producer,
      targetId: target._id,
      targetName: target.name,
      targetProducer: target.producer,
      bottlesMoved,
      imageAction,
    }
  );

  await source.deleteOne();
  searchService.removeWine(String(sourceId));
  // Target was mutated if we adopted the image; re-index so search sees it
  if (imageAction === 'adopted_from_source') searchService.indexWine(targetId);

  // Close the source's PENDING correction proposals — a pending row whose
  // subject wine is gone would dangle forever: the review list renders a null
  // wine, approve 404s and reverts its claim back to pending, and the
  // AdminWines badge stays inflated (audit 2026-08-10 MED). Auto-reject with
  // the reason rather than re-point: the merge usually RESOLVES the complaint,
  // and silently re-targeting what an admin later approves would be spookier
  // than asking the somm to re-file against the keeper. decidedBy stays null —
  // this is lifecycle closure, not a reviewer's judgement.
  const keeperLabel = [target.producer, target.name].filter(Boolean).join(' — ');
  // The shared closer also TELLS a user who filed one (pre-deploy audit
  // 2026-09-18): this is where a correction that made the wine collide with its
  // twin ends up, and the bottle now points at the keeper, so nothing on the
  // web would ever show them the outcome. The notification links to the keeper.
  await closePendingForWine(
    sourceId,
    `Closed automatically: the wine was merged into "${keeperLabel}". Re-file against that wine if the issue still applies.`.slice(0, 500),
    { wine: source, linkWineId: targetId, actorId: req?.user?.id }
  );

  // Owner inquiries take the opposite path to proposals: the merge does NOT
  // resolve the question — the bottles (and their owners) moved to the keeper,
  // so active inquiries FOLLOW them. Only an open inquiry colliding with the
  // keeper's own open one closes (with the proposal-style reason).
  await repointInquiriesForWineMerge(sourceId, targetId, keeperLabel, req);

  // Re-embed the keeper's vintages (it just absorbed the source's bottles and
  // possibly its profile) so semantic search reflects the merged wine.
  reembedKeeper(targetId);

  return { bottlesMoved, imageAction, source, target };
}

// ── Merge embedding / enrichment consistency helpers ─────────────────────────

// Delete a merged-away (or deleted) wine's vectors: they live on its
// WineEmbedding rows, so dropping the rows is the whole job.
async function purgeSourceVectors(sourceId) {
  await WineEmbedding.deleteMany({ wineDefinition: sourceId });
}

// If the keeper has no AI tasting profile, inherit the best one (highest
// confidence) from the wines being merged in, so the keeper's re-embedding still
// encodes taste/style instead of dropping to identity-only text. Free — no AI
// call. No-op when the keeper is already enriched or no source has a profile.
// A profile a curator wrote or reviewed: the curator source, or a review
// stamp no older than the profile (the low-confidence queue's own test).
function isCuratedProfile(w) {
  const p = w.aiProfile;
  if (!p?.description) return false;
  if (p.source === 'curator') return true;
  return Boolean(w.profileReviewedAt && (!p.generatedAt || w.profileReviewedAt >= p.generatedAt));
}

// The verdicts about a record's PRODUCER live on its profile but belong to the
// record: in a merge the donor is usually the one with the wrong identity
// ("Fabelhaft" merged into "Niepoort"), so its producer doubts must not land
// on the keeper with the tasting text.
const PRODUCER_VERDICT_FIELDS = ['producerSuspect', 'producerUnknown', 'producerNote', 'suspectDecision', 'suspectDecidedAt', 'suspectDowngradedBy'];

const plainProfile = (p) => (p && typeof p.toObject === 'function' ? p.toObject() : { ...(p || {}) });

// Which tasting profile the keeper ends up with. A curated profile always
// wins over an unreviewed one: before 2026-09-28 the keeper's own profile
// was kept whenever it had one, so merging "Château Mouton-Rothschild" (a
// curator-reviewed profile) into "Château Mouton Rothschild" (an old AI one)
// threw the reviewed profile away with the deleted record. Among equals, the
// keeper keeps its own; among donors, the highest model confidence wins.
async function inheritAiProfile(keeper, sources) {
  if (isCuratedProfile(keeper)) return;
  const withProfile = sources.filter(w => w.aiProfile?.description);
  const byConfidence = (a, b) => (b.aiProfile.confidence ?? 0) - (a.aiProfile.confidence ?? 0);
  const donor = withProfile.filter(isCuratedProfile).sort(byConfidence)[0]
    || (keeper.aiProfile?.description ? null : withProfile.sort(byConfidence)[0]);
  if (!donor) return;
  const profile = plainProfile(donor.aiProfile);
  const set = { aiProfile: profile };
  if (isCuratedProfile(donor)) {
    // The tasting text and its provenance travel; the producer verdicts stay
    // the keeper's own. The donor's input snapshot describes the donor's
    // identity — cleared rather than compared (a curated profile is never
    // regenerated anyway).
    const own = plainProfile(keeper.aiProfile);
    for (const f of PRODUCER_VERDICT_FIELDS) {
      if (own[f] === undefined) delete profile[f]; else profile[f] = own[f];
    }
    profile.inputsSnapshot = null;
    // The review travels with the profile it vouches for; otherwise the keeper
    // would land in the low-confidence queue holding a profile already reviewed.
    if (donor.profileReviewedAt) set.profileReviewedAt = donor.profileReviewedAt;
  } else if (keeper.profileReviewedAt) {
    // An inherited UNREVIEWED profile must not look reviewed through the
    // keeper's older stamp (it vouched for a profile the keeper no longer has).
    set.profileReviewedAt = null;
  }
  keeper.aiProfile = profile;
  if ('profileReviewedAt' in set) keeper.profileReviewedAt = set.profileReviewedAt;
  // updatedAt: the keeper's profile changed, and the Bridge sends it.
  await WineDefinition.updateOne({ _id: keeper._id }, { $set: { ...set, updatedAt: new Date() } });
}

// Re-embed every active vintage the keeper now owns so the vector store reflects
// the merged-in bottles (and any inherited profile). Mirrors the bottle-add hook:
// embedSinglePair is a no-op when the text is unchanged and self-skips while a
// batch embedding job is running. Fire-and-forget; never throws.
async function reembedKeeper(keeperId) {
  try {
    const vintages = await Bottle.distinct('vintage', { wineDefinition: keeperId, status: 'active' });
    for (const v of vintages) {
      await embedSinglePair(keeperId, v).catch(() => {});
    }
  } catch (err) {
    console.warn('[merge] re-embed keeper failed (%s):', keeperId, err.message);
  }
}

// Wine list entries reference WineDefinition directly (wine+vintage+size key),
// so a merge must re-point them or the wine silently vanishes from published
// menus and PDFs. Idempotent like the other reassigns. A list that already had
// an entry for the keeper may end up with two entries for the same wine — the
// owner sees both in the editor and can remove one; vanishing silently is the
// failure mode we must avoid.
function reassignWineListEntries(sourceId, keeperId) {
  return Promise.all([
    WineList.updateMany(
      { 'autoGroupEntries.wine': sourceId },
      { $set: { 'autoGroupEntries.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
    WineList.updateMany(
      { 'sections.entries.wine': sourceId },
      { $set: { 'sections.$[].entries.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
  ]);
}

// Re-point a source wine's maturity profiles onto the keeper, reconciling the
// unique (wineDefinition, vintage) index. A plain updateMany would throw E11000
// whenever BOTH wines already have a profile for the same vintage — common now
// that every added/imported bottle seeds a pending profile — which would abort
// the whole merge. Per source profile:
//   - keeper has none for that vintage  → move it (re-point in place)
//   - keeper has only a 'pending' one, source is 'reviewed' → keep the curated
//     source window (drop the keeper's pending, then re-point the source's)
//   - otherwise (keeper already 'reviewed', or both 'pending') → drop the
//     source's; the keeper is the golden record and wins ties.
// Idempotent + re-runnable: moved/dropped source profiles are simply not found
// on a re-run. Errors propagate to the route's catch (sources deleted last).
async function reassignVintageProfiles(sourceId, keeperId) {
  const sourceProfiles = await WineVintageProfile
    .find({ wineDefinition: sourceId }).select('vintage status').lean();
  if (sourceProfiles.length === 0) return;
  const keeperProfiles = await WineVintageProfile
    .find({ wineDefinition: keeperId }).select('vintage status').lean();
  const keeperByVintage = new Map(keeperProfiles.map(p => [p.vintage, p]));

  for (const sp of sourceProfiles) {
    const kp = keeperByVintage.get(sp.vintage);
    // updatedAt: a window moving onto the keeper is a change to the keeper
    // for the Registry Bridge change check (routes/bridgeV1), which reads it.
    if (!kp) {
      await WineVintageProfile.updateOne({ _id: sp._id }, { $set: { wineDefinition: keeperId, updatedAt: new Date() } });
      // Track it so a second source with the same vintage reconciles against this one.
      keeperByVintage.set(sp.vintage, { vintage: sp.vintage, status: sp.status });
    } else if (kp.status !== 'reviewed' && sp.status === 'reviewed') {
      await WineVintageProfile.deleteOne({ wineDefinition: keeperId, vintage: sp.vintage });
      await WineVintageProfile.updateOne({ _id: sp._id }, { $set: { wineDefinition: keeperId, updatedAt: new Date() } });
      keeperByVintage.set(sp.vintage, { vintage: sp.vintage, status: 'reviewed' });
    } else {
      await WineVintageProfile.deleteOne({ _id: sp._id });
    }
  }
}

// Re-point docs of a model that has a UNIQUE index of (wineDefinition + keyFields)
// from source→keeper, reconciling collisions a plain updateMany would choke on.
// Per source doc: if the keeper has no doc with the same key it is moved in place;
// otherwise the keeper's row wins — onCollision (if given) merges anything worth
// keeping off the source doc, then the source doc is dropped.
// Idempotent + re-runnable: already-moved/dropped source docs aren't found again.
async function reassignKeyedRefs(Model, sourceId, keeperId, keyFields, onCollision) {
  const sourceDocs = await Model.find({ wineDefinition: sourceId }).lean();
  if (sourceDocs.length === 0) return;
  const keyOf = (d) => keyFields.map(f => String(d[f] ?? '')).join('|');
  const keeperDocs = await Model.find({ wineDefinition: keeperId })
    .select(keyFields.join(' ')).lean();
  const keeperKeys = new Set(keeperDocs.map(keyOf));

  for (const sd of sourceDocs) {
    const k = keyOf(sd);
    if (!keeperKeys.has(k)) {
      await Model.updateOne({ _id: sd._id }, { $set: { wineDefinition: keeperId } });
      keeperKeys.add(k); // a later source doc with the same key now collides
    } else {
      if (onCollision) await onCollision(sd, keeperId);
      await Model.deleteOne({ _id: sd._id });
    }
  }
}

// Collision handler for PriceTrackingRequest: fold the colliding source request's
// requesters (deduped by user) into the keeper's existing request for that vintage
// so no opted-in user loses their price-tracking notification, and widen the
// first/last-requested span across both.
async function mergePriceTrackingRequesters(sourceDoc, keeperId) {
  const keeperReq = await PriceTrackingRequest.findOne({ wineDefinition: keeperId, vintage: sourceDoc.vintage });
  if (!keeperReq) return; // collision implies it exists, but stay defensive
  const have = new Set(keeperReq.requesters.map(r => String(r.user)));
  let changed = false;
  for (const r of sourceDoc.requesters || []) {
    if (!have.has(String(r.user))) { keeperReq.requesters.push(r); have.add(String(r.user)); changed = true; }
  }
  if (sourceDoc.firstRequestedAt && sourceDoc.firstRequestedAt < keeperReq.firstRequestedAt) {
    keeperReq.firstRequestedAt = sourceDoc.firstRequestedAt; changed = true;
  }
  if (sourceDoc.lastRequestedAt && sourceDoc.lastRequestedAt > keeperReq.lastRequestedAt) {
    keeperReq.lastRequestedAt = sourceDoc.lastRequestedAt; changed = true;
  }
  if (changed) await keeperReq.save();
}

// Re-point the source wine inside RestockAlert.similarWineIds[] (an array ref).
// $addToSet the keeper first (while the source still matches the filter), then
// $pull the source — so the keeper isn't duplicated if it was already present.
// Idempotent: a re-run finds no remaining source entries to match.
async function reassignRestockSimilar(sourceId, keeperId) {
  await RestockAlert.updateMany({ similarWineIds: sourceId }, { $addToSet: { similarWineIds: keeperId } });
  await RestockAlert.updateMany({ similarWineIds: sourceId }, { $pull: { similarWineIds: sourceId } });
}

// Reassign every reference from one source wine to the keeper. Idempotent
// (updateMany by wineDefinition) and does NOT delete the source, so it's safe
// to re-run after a partial failure. Returns the number of bottles moved.
async function reassignWineRefs(sourceId, keeperId) {
  const owners = await Bottle.distinct('user', { wineDefinition: sourceId });
  const bottleRes = await Bottle.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } });
  // Their owners' statistics change with it; after the write, so no cache
  // pairs the new version with the old data (services/dataVersion).
  owners.forEach(bumpDataVersion);
  await Promise.all([
    reassignWineListEntries(sourceId, keeperId),
    // Bottles in a "Recently deleted" follow the merge, so a restore lands on
    // the kept wine instead of failing on the merged-away one.
    DeletedBottle.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    BottleImage.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Maturity profiles need collision reconciliation (unique wineDefinition+vintage).
    reassignVintageProfiles(sourceId, keeperId),
    WineVintagePrice.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    WineReport.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    Discussion.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    DiscussionReply.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Delete the source's vectors (its WineEmbedding rows).
    purgeSourceVectors(sourceId),
    // Drop any "not duplicate" decisions referencing the disappearing source.
    WineNotDuplicate.deleteMany({ $or: [{ wineA: sourceId }, { wineB: sourceId }] }),
    // Reviews have no unique index on (author, wineDefinition) — a user may
    // hold several reviews per wine — so a plain re-point cannot collide.
    Review.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Wishlist items: re-point so a user who wishlisted the source wine doesn't
    // end up pointing at a deleted one. No unique index here, so a plain re-point
    // is safe; a user who wanted both merged wines may briefly see two rows —
    // prefer a removable dupe over silent loss (same policy as wine-list entries).
    WishlistItem.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Price-tracking opt-ins (unique wineDefinition+vintage): merge requesters on
    // collision so nobody loses their notification; otherwise move the request.
    reassignKeyedRefs(PriceTrackingRequest, sourceId, keeperId, ['vintage'], mergePriceTrackingRequesters),
    // Price-tracking skips (unique wineDefinition+vintage): keeper's skip wins.
    reassignKeyedRefs(PriceTrackingSkip, sourceId, keeperId, ['vintage']),
    // Community prices are a DERIVED aggregate (communityPriceJob recomputes them
    // from bottles). Re-pointing a stale median would be wrong — just drop the
    // source's; the job rebuilds the keeper's from the now-merged bottle set.
    CommunityWinePrice.deleteMany({ wineDefinition: sourceId }),
    // Remaining WineDefinition references that use a non-`wineDefinition` field
    // name — re-point so they don't dangle when the source wine is deleted. None
    // has a unique index on the wine ref, so a plain updateMany is safe.
    // JournalEntry holds the wine ref nested in pairings[].wine (not top-level),
    // so it needs an arrayFilter like the wine-list entries above.
    JournalEntry.updateMany(
      { 'pairings.wine': sourceId },
      { $set: { 'pairings.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
    Recommendation.updateMany({ wine: sourceId }, { $set: { wine: keeperId } }),
    RestockAlert.updateMany({ wine: sourceId }, { $set: { wine: keeperId } }),
    reassignRestockSimilar(sourceId, keeperId),
    WineReport.updateMany({ duplicateOf: sourceId }, { $set: { duplicateOf: keeperId } }),
    WineRequest.updateMany({ linkedWineDefinition: sourceId }, { $set: { linkedWineDefinition: keeperId } }),
    // Members' wine-level personal data entries follow their bottles (they are
    // read through the bottle's wine). No unique index on (author, wine), so a
    // plain re-point cannot collide: a member with entries on both wines may
    // see a key twice, a removable duplicate over silent loss (same policy as
    // wishlist items). The authors' data version moves like the bottle
    // owners' — analyze_cellar reads personal keys behind that cache.
    (async () => {
      const authors = await PersonalDataEntry.distinct('author', { wineDefinition: sourceId });
      await PersonalDataEntry.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } });
      authors.forEach(bumpDataVersion);
    })(),
    // Registry data values. Rejected rows sit outside the unique
    // (wine, key, vintage, status) index and move plainly; a suggested or
    // published row moves unless the keeper already holds one for that slot,
    // which wins (the source's row is dropped).
    (async () => {
      await RegistryDataValue.updateMany({ wineDefinition: sourceId, status: 'rejected' }, { $set: { wineDefinition: keeperId } });
      await reassignKeyedRefs(RegistryDataValue, sourceId, keeperId, ['key', 'vintage', 'status']);
    })(),
  ]);
  return bottleRes.modifiedCount || 0;
}

module.exports = {
  performWineMerge,
  purgeSourceVectors,
  inheritAiProfile,
  reembedKeeper,
  reassignWineRefs,
};
