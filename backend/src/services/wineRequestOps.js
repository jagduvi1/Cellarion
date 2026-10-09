/**
 * Finishing a wine request — ONE implementation for the admin review routes
 * (routes/admin/wineRequests.js) and the Registry Bridge request sync
 * (services/registryBridge.syncForwardedRequests), so a request answered on
 * cellarion.app finishes on a self-hosted install exactly as an admin
 * decision there would: the same bottles move, the same notification goes out.
 *
 * Both take a loaded WineRequest that is still 'pending'; the caller checks
 * that, and decides WHICH wine (resolve) or WHY (reject).
 */
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const { bumpDataVersion } = require('./dataVersion');
const { createNotification } = require('./notifications');
const { stripHtml } = require('../utils/sanitize');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');

/**
 * Mark the request resolved against `linkedWine`, then move the bottles that
 * waited on it onto the wine, stamp their photos with it, queue their
 * vintages for a drink window, and tell the requester.
 * Returns { backfilledCount }.
 */
async function completeRequestResolve(wineRequest, linkedWine, { resolvedBy = null, adminNotes = '' } = {}) {
  wineRequest.status = 'resolved';
  wineRequest.resolvedBy = resolvedBy;
  wineRequest.resolvedAt = new Date();
  wineRequest.linkedWineDefinition = linkedWine._id;
  wineRequest.adminNotes = adminNotes ? stripHtml(adminNotes) : '';
  await wineRequest.save();

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
    // list, bottle page) see them on every bottle of the wine (support
    // ticket 2026-09-07). Best-effort — a failure here must not undo the link.
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
  createNotification(wineRequest.user, 'wine_request_resolved', 'Wine request approved', notifMsg, '/wine-requests');

  return { backfilledCount };
}

/**
 * Mark the request rejected with `adminNotes` as the reason, after detaching
 * the bottles that waited on it, and tell the requester.
 * Returns { bottlesDetached }.
 */
async function completeRequestReject(wineRequest, { resolvedBy = null, adminNotes } = {}) {
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
  await wineRequest.save();

  let notifMsg = `Your request for "${wineRequest.wineName}" was declined. Reason: ${reason}`;
  if (bottlesDetached > 0) {
    notifMsg += ` Your ${bottlesDetached} bottle${bottlesDetached !== 1 ? 's' : ''} awaiting this wine remain in your cellar without a linked registry wine.`;
  }
  createNotification(wineRequest.user, 'wine_request_rejected', 'Wine request declined', notifMsg, '/wine-requests');

  return { bottlesDetached };
}

module.exports = { completeRequestResolve, completeRequestReject };
