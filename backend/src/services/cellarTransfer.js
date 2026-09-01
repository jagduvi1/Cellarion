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
  cellar.members = (cellar.members || []).filter((m) => String(m.user) !== String(newOwner._id));
  cellar.members.push({ user: currentOwner, role: 'editor', addedAt: new Date() });
  cellar.user = newOwner._id;
  await cellar.save();

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
