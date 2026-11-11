/**
 * Finishing a wine request — ONE implementation for the admin review routes
 * (routes/admin/wineRequests.js) and the Registry Bridge request sync
 * (services/registryBridge.syncForwardedRequests), so a request answered on
 * cellarion.app finishes on a self-hosted install exactly as an admin
 * decision there would: the same bottles move, the same notification goes out
 * (on cellarion.app the key owner is not notified as well when the install
 * follows the request — see answeredByInstall).
 *
 * Both take a loaded WineRequest that was 'pending' when loaded; the caller
 * checks that, and decides WHICH wine (resolve) or WHY (reject). The status
 * write itself only lands while the request is STILL pending (savePending):
 * the hourly sync holds a loaded request for minutes while it copies wines,
 * and an admin deciding the same request meanwhile must not be overwritten.
 * The one that comes second gets null back and changes nothing more.
 *
 * One decision works on a request at a time. A decision first takes the
 * request (claimRequest), and only the holder goes on: an admin's resolve
 * creates the wine and its pictures BEFORE the status write, so two resolves
 * that both passed the "is it pending?" look each created one. The admin
 * routes take the request before they do anything; the bridge sync lets the
 * two functions here take it.
 */
const WineRequest = require('../models/WineRequest');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const { bumpDataVersion } = require('./dataVersion');
const { createNotification } = require('./notifications');
const { stripHtml } = require('../utils/sanitize');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');

// How long a claim holds. A resolve that creates a wine also cuts out and
// stores its pictures; past this the claim is taken to be an abandoned one
// (the process ended mid-decision) and the request can be decided again.
const CLAIM_MS = 5 * 60 * 1000;

/**
 * Take a pending request for one decision. Callers: the admin resolve and
 * reject routes (routes/admin/wineRequests.js), and the two functions below
 * for a caller that has not taken it (the Registry Bridge request sync).
 * Returns { request } — the request as stored, now held by the caller — or
 * { refused: 'decided' } when it is no longer pending (or not there), or
 * { refused: 'busy' } when another decision holds it.
 */
async function claimRequest(requestId) {
  const now = new Date();
  const request = await WineRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending', $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }] },
    { $set: { claimedAt: now } },
    { new: true }
  );
  if (request) return { request };
  const pending = await WineRequest.exists({ _id: requestId, status: 'pending' });
  return { refused: pending ? 'busy' : 'decided' };
}

/**
 * Give a request back undecided: the decision was refused or failed. Only a
 * pending request has a claim to clear. Callers: the admin routes.
 */
async function releaseRequestClaim(requestId) {
  await WineRequest.updateOne({ _id: requestId, status: 'pending' }, { $set: { claimedAt: null } });
}

// True when the caller may go on with its decision: it already holds the
// request, or takes it here.
async function heldForDecision(wineRequest, holdsClaim) {
  if (holdsClaim) return true;
  const claim = await claimRequest(wineRequest._id);
  return !claim.refused;
}

// Save only if the stored request is still pending (Mongoose adds `$where`
// to the save's filter). False when someone else decided it first. The
// decision is stored, so the claim goes with the same write.
async function savePending(wineRequest) {
  wineRequest.claimedAt = null;
  wineRequest.markModified('claimedAt');
  wineRequest.$where = { status: 'pending' };
  try {
    await wineRequest.save();
    return true;
  } catch (err) {
    if (err && err.name === 'DocumentNotFoundError') return false;
    throw err;
  } finally {
    wineRequest.$where = undefined;
  }
}

// A request a self-hosted install filed through the Registry Bridge, where the
// install has shown it follows that request (installFollowsAt, set by the
// bridge routes), is answered to its requester by the install: the hourly
// sync (services/registryBridge.syncForwardedRequests) finishes it there and
// notifies the local user. The key owner's account here never filed anything
// in this app, so a second bell on cellarion.app is noise, and it reads as the
// two accounts being linked by something other than the key.
// The bell here stays when the install will never hear: one older than
// v1.252.0, a request forwarded before it upgraded (no installFollowsAt), or a
// resolve to a wine the bridge does not serve (pending identity / not a wine —
// the sync cannot copy it, so it never finishes there). Bridge corrections and
// values have no sync at all, so their notifications always stay.
function answeredByInstall(wineRequest, linkedWine = null) {
  if (wineRequest.via !== 'bridge' || !wineRequest.installFollowsAt) return false;
  // Not served over the bridge (a private draft is pendingIdentity too): the
  // install cannot finish the request, so the notification here stays.
  if (linkedWine && (linkedWine.nonWine === true || linkedWine.pendingIdentity === true)) return false;
  return true;
}

/**
 * Mark the request resolved against `linkedWine`, then move the bottles that
 * waited on it onto the wine, stamp their photos with it, queue their
 * vintages for a drink window, and tell the requester.
 * Returns { backfilledCount }, or null when the request was no longer pending
 * or another decision holds it. `holdsClaim`: the caller took the request
 * with claimRequest; otherwise it is taken here.
 */
async function completeRequestResolve(wineRequest, linkedWine, { resolvedBy = null, adminNotes = '', holdsClaim = false } = {}) {
  if (!(await heldForDecision(wineRequest, holdsClaim))) return null;
  wineRequest.status = 'resolved';
  wineRequest.resolvedBy = resolvedBy;
  wineRequest.resolvedAt = new Date();
  wineRequest.linkedWineDefinition = linkedWine._id;
  wineRequest.adminNotes = adminNotes ? stripHtml(adminNotes) : '';
  if (!(await savePending(wineRequest))) return null;

  // Backfill any bottles that were imported while waiting for this wine
  let backfilledCount = 0;
  if (wineRequest.requestType === 'new_wine') {
    // Capture the distinct vintages BEFORE the update unsets pendingWineRequest
    // — needed to seed the maturity queue once the wine is known. Bottles on
    // order are left out: they are queued when they arrive.
    const pendingVintages = await Bottle.distinct('vintage', { pendingWineRequest: wineRequest._id, status: { $ne: 'ordered' } });
    const pendingBottleIds = await Bottle.distinct('_id', { pendingWineRequest: wineRequest._id });
    const pendingOwners = await Bottle.distinct('user', { pendingWineRequest: wineRequest._id });

    const result = await Bottle.updateMany(
      { pendingWineRequest: wineRequest._id },
      { $set: { wineDefinition: linkedWine._id }, $unset: { pendingWineRequest: '' } }
    );
    backfilledCount = result.modifiedCount || 0;
    // Their owners' statistics change with it; after the write, so no cache
    // pairs the new version with the old data (services/dataVersion).
    pendingOwners.forEach(bumpDataVersion);

    // Photos uploaded while these bottles waited for their wine carry no
    // wineDefinition; stamp it now so the by-wine photo lookups (cellar
    // list, bottle page) see them on every bottle of the wine. Best-effort —
    // a failure here must not undo the link.
    if (pendingBottleIds.length) {
      BottleImage.updateMany(
        { bottle: { $in: pendingBottleIds }, wineDefinition: null },
        { $set: { wineDefinition: linkedWine._id } }
      ).catch((err) => console.error('[wine-requests] image wine stamp failed:', err.message));
    }

    // Now that these bottles have a real wineDefinition, put each wine+vintage
    // into the sommelier maturity queue — mirroring the hand-add and matched-
    // import paths. Without this, wines that entered via an import "request"
    // never surfaced for a somm to set a drink window.
    for (const vintage of pendingVintages) {
      await ensurePendingVintageProfile(linkedWine._id, vintage);
    }
  }

  let notifMsg;
  if (wineRequest.requestType === 'grape_suggestion') {
    notifMsg = `Your grape suggestion for "${wineRequest.wineName}" has been reviewed. Thank you for helping improve the wine registry!`;
  } else if (backfilledCount > 0) {
    const many = backfilledCount !== 1;
    notifMsg = `Your request for "${wineRequest.wineName}" has been approved and added to the registry as "${linkedWine.name}" by ${linkedWine.producer}. Your ${backfilledCount} bottle${many ? 's' : ''} in the cellar ${many ? 'have' : 'has'} been updated.`;
  } else {
    notifMsg = `Your request for "${wineRequest.wineName}" has been approved. It was added to the registry as "${linkedWine.name}" by ${linkedWine.producer}.`;
  }
  if (!answeredByInstall(wineRequest, linkedWine)) {
    createNotification(wineRequest.user, 'wine_request_resolved', 'Wine request approved', notifMsg, '/wine-requests');
  }

  return { backfilledCount };
}

/**
 * Mark the request rejected with `adminNotes` as the reason, after detaching
 * the bottles that waited on it, and tell the requester.
 * Returns { bottlesDetached }, or null when the request was no longer pending
 * or another decision holds it (nothing is detached then). `holdsClaim`: as
 * for completeRequestResolve.
 */
async function completeRequestReject(wineRequest, { resolvedBy = null, adminNotes, holdsClaim = false } = {}) {
  if (!(await heldForDecision(wineRequest, holdsClaim))) return null;
  // Detach any bottles that were imported pending this request — the mirror
  // of resolve's backfill above. A rejected request can never become
  // resolvable again, and wineDefinition isn't user-updatable, so a bottle
  // left pointing at it would be permanently stranded; unset the reference
  // and the bottle falls back to the normal editable "no wine" state.
  // Runs BEFORE the status flip: if the detach fails the request is still
  // pending, so a retry re-runs it (the $unset is idempotent). Saved first,
  // a detach failure would leave the request rejected behind the not-pending
  // guard — re-stranding the bottles permanently, the exact condition this
  // detach exists to fix.
  let bottlesDetached = 0;
  if (wineRequest.requestType === 'new_wine') {
    const pendingOwners = await Bottle.distinct('user', { pendingWineRequest: wineRequest._id });
    const result = await Bottle.updateMany(
      { pendingWineRequest: wineRequest._id },
      { $unset: { pendingWineRequest: '' } }
    );
    bottlesDetached = result.modifiedCount || 0;
    // Their owners' statistics and bottle lists change with it — the same
    // bump resolve makes (services/dataVersion; audit 2026-09-27 M6).
    pendingOwners.forEach(bumpDataVersion);
  }

  const reason = String(adminNotes || '').trim();
  wineRequest.status = 'rejected';
  wineRequest.resolvedBy = resolvedBy;
  wineRequest.resolvedAt = new Date();
  wineRequest.adminNotes = reason;
  if (!(await savePending(wineRequest))) return null;

  let notifMsg = `Your request for "${wineRequest.wineName}" was declined. Reason: ${reason}`;
  if (bottlesDetached > 0) {
    notifMsg += ` Your ${bottlesDetached} bottle${bottlesDetached !== 1 ? 's' : ''} awaiting this wine remain in your cellar without a linked registry wine.`;
  }
  if (!answeredByInstall(wineRequest)) {
    createNotification(wineRequest.user, 'wine_request_rejected', 'Wine request declined', notifMsg, '/wine-requests');
  }

  return { bottlesDetached };
}

module.exports = { claimRequest, releaseRequestClaim, completeRequestResolve, completeRequestReject };
