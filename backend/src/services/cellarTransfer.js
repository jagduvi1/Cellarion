/**
 * Cellar ownership transfer — hand a cellar, its bottles and its racks to
 * another account, keeping the outgoing owner on as an editor.
 *
 * WHY THIS EXISTS (#1055-adjacent; asked for by a professional managing client
 * cellars, 2026-09-01). The workflow it unblocks: someone builds a cellar
 * completely under their own account — import, racks, placement — and then
 * hands it to the person who actually owns the wine, staying on as an editor to
 * keep adding stock. Without transfer, the choice was to own your client's data
 * for ever or to make the client do the setup themselves.
 *
 * WHY IT MOVES THREE COLLECTIONS, NOT ONE
 *
 * `user` on Cellar, Bottle and Rack each independently means "whose is this",
 * and — the part that makes a half-transfer dangerous — account deletion purges
 * all three BY THAT FIELD (services/userDataRegistry). Move only the cellar and
 * you leave the new owner holding bottles that are still scheduled to be
 * destroyed when the previous owner closes their account. So a transfer that
 * does not move the bottles is not a transfer; it is a time bomb.
 *
 * WHAT DELIBERATELY DOES NOT MOVE
 *
 * Anything authored BY a person rather than owned WITH the cellar: journal
 * entries, reviews, wishlist items, wine lists, import sessions and archives
 * (they are the record of who imported what — provenance, not property),
 * uploaded-image attribution, and value snapshots. Those belong to whoever
 * wrote them and stay put.
 *
 * ORDERING, BECAUSE THERE ARE NO TRANSACTIONS
 *
 * Production MongoDB is standalone, so there is no multi-document transaction
 * to hide behind. The order below is the safety mechanism:
 *
 *   1. bottles   2. racks   3. the cellar itself, LAST
 *
 * The cellar flips last because until it does, the outgoing owner still owns
 * everything and a failed run is simply retried. Flip the cellar first and a
 * failure at step 2 leaves the new owner owning a cellar whose bottles still
 * purge with the old owner's account — precisely the state this exists to
 * prevent. Every step is an idempotent `updateMany` keyed on the OLD owner, so
 * re-running a partial transfer completes it and re-running a finished one does
 * nothing.
 *
 * Last-step ordering is necessary but not sufficient, because the LAST step is
 * the one that can be refused: a cellar name is unique per owner, so a
 * recipient who already has a cellar of that name makes the final save
 * impossible — after the bottles and racks have moved, and in a way no re-run
 * repairs (the bottles no longer match the old owner). So the transfer first
 * checks that the cellar can land, and still rolls the exact moved documents
 * back if the save fails anyway. A transfer either happens or leaves no trace.
 */

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const User = require('../models/User');

/** An error the route can turn straight into a status code. */
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Move ownership of a cellar to another account.
 *
 * @param {string} cellarId
 * @param {string} newOwnerId  must already be a member of the cellar
 * @param {string} actorId     must be the current owner
 * @returns {Promise<{cellar: object, bottlesMoved: number, racksMoved: number,
 *                    previousOwner: string, newOwner: string}>}
 */
async function transferCellarOwnership(cellarId, newOwnerId, actorId) {
  const cellar = await Cellar.findOne({ _id: cellarId, deletedAt: null });
  if (!cellar) throw fail(404, 'Cellar not found');

  const currentOwner = String(cellar.user);
  if (currentOwner !== String(actorId)) {
    throw fail(403, 'Only the cellar owner can transfer ownership');
  }
  if (currentOwner === String(newOwnerId)) {
    throw fail(400, 'That account already owns this cellar');
  }

  // The recipient must already be a member. This is the consent step: someone
  // cannot be handed responsibility for a stranger's wine collection — and its
  // storage costs, and its GDPR position — without having been invited to it
  // first. It also guarantees the recipient is a real, registered account.
  const isMember = (cellar.members || []).some((m) => String(m.user) === String(newOwnerId));
  if (!isMember) {
    throw fail(400, 'The new owner must already be a member of this cellar');
  }

  const newOwner = await User.findById(newOwnerId).select('_id username email').lean();
  if (!newOwner) throw fail(404, 'New owner account not found');

  // ── 0. Can the cellar actually LAND? A cellar name is unique per owner
  //       (models/Cellar: unique { user, name } over active cellars), so if the
  //       recipient already has a cellar of this name the final save at step 3
  //       is impossible. Checked BEFORE anything moves, because the failure it
  //       prevents is the one this service exists to prevent: the bottles and
  //       racks would already have changed hands, leaving a collection owned by
  //       one account inside a cellar owned by another — and a re-run cannot
  //       repair it, since the bottles no longer match the old owner. On the
  //       hosted service 30 cellar names are already held by more than one
  //       account, so this is an ordinary case, not a corner.
  const clash = await Cellar.exists({ user: newOwner._id, name: cellar.name, deletedAt: null });
  if (clash) {
    throw fail(409, `The new owner already has a cellar named "${cellar.name}". Rename one of them first — one account cannot hold two cellars with the same name.`);
  }

  // Exact ids, captured before the writes, so a failure at step 3 can be undone
  // precisely. A blind inverse update would be wrong: the recipient was already
  // a member and may own bottles in this cellar themselves, and those must not
  // be handed to the outgoing owner by a rollback.
  const movedBottleIds = await Bottle.find({ cellar: cellar._id, user: currentOwner }).distinct('_id');
  const movedRackIds = await Rack.find({ cellar: cellar._id, user: currentOwner }).distinct('_id');

  // ── 1. Bottles. Soft-deleted ones included on purpose: they are restorable,
  //       and the deletion cascade would take them too.
  const bottles = await Bottle.updateMany(
    { cellar: cellar._id, user: currentOwner },
    { $set: { user: newOwner._id } },
  );

  // ── 2. Racks, same reasoning.
  const racks = await Rack.updateMany(
    { cellar: cellar._id, user: currentOwner },
    { $set: { user: newOwner._id } },
  );

  // ── 3. The cellar itself, last.
  //       The outgoing owner becomes an editor so they keep working access —
  //       the whole point of the professional workflow — and the incoming owner
  //       leaves the member list, because owner is not a membership row.
  // Also drop any stray row for the CURRENT owner: owner was never a
  // membership row, but if a data anomaly ever put one there, pushing below
  // would duplicate it.
  const previousMembers = cellar.members;
  cellar.members = (cellar.members || []).filter(
    (m) => String(m.user) !== String(newOwner._id) && String(m.user) !== currentOwner,
  );
  cellar.members.push({ user: currentOwner, role: 'editor', addedAt: new Date() });
  cellar.user = newOwner._id;
  try {
    await cellar.save();
  } catch (err) {
    // The step-0 check makes the duplicate-name case unreachable in practice,
    // but a save can still fail — the recipient creating a same-named cellar in
    // the gap, a validation error, the database going away. Whatever the cause,
    // the half-moved state must not survive: put the exact documents back and
    // report a failure the caller can simply retry.
    cellar.user = currentOwner;
    cellar.members = previousMembers;
    await Promise.all([
      movedBottleIds.length
        ? Bottle.updateMany({ _id: { $in: movedBottleIds } }, { $set: { user: currentOwner } })
        : null,
      movedRackIds.length
        ? Rack.updateMany({ _id: { $in: movedRackIds } }, { $set: { user: currentOwner } })
        : null,
    ].filter(Boolean)).catch((rollbackErr) => {
      // A failed rollback is the one state worth shouting about: the bottles
      // are with the new owner and the cellar is not.
      console.error(
        `[cellarTransfer] ROLLBACK FAILED for cellar ${cellar._id}: ${movedBottleIds.length} bottle(s) and ` +
        `${movedRackIds.length} rack(s) may still be owned by ${newOwner._id} inside a cellar owned by ${currentOwner}`,
        rollbackErr.message,
      );
    });
    if (err && err.code === 11000) {
      throw fail(409, `The new owner already has a cellar named "${cellar.name}". Rename one of them first — one account cannot hold two cellars with the same name.`);
    }
    throw err;
  }

  return {
    cellar,
    bottlesMoved: bottles.modifiedCount || 0,
    racksMoved: racks.modifiedCount || 0,
    previousOwner: currentOwner,
    newOwner: String(newOwner._id),
    newOwnerName: newOwner.username,
  };
}

module.exports = { transferCellarOwnership };
