// Account erasure for the undo ledger's snapshots of OTHER people's data.
//
// An McpActionLog row belongs to the curator who made the change, so the
// ledger entry of the erasure registry (services/userDataRegistry) deletes
// only the erased user's own rows. A snapshot (`prev`) can still name someone
// else: the curator whose stamp and note sat on a drink window, the members
// who asked for a price. An undo after their erasure would write them back,
// so the registry entries of those two models run these passes. Both match
// the user as a string, which is how the snapshots keep it.

const McpActionLog = require('../models/McpActionLog');

/**
 * Take an erased curator out of drink-window snapshots (set_vintage_maturity,
 * reset_maturity_row, remove_from_maturity_queue): the stamp always, the note
 * too unless it is `keepNote` — the Registry Bridge's marker, which is not
 * personal and is how the bridge knows a row as its own. Caller: the
 * WineVintageProfile entry of services/userDataRegistry. Returns the last
 * updateMany result.
 */
async function eraseCuratorFromWindowSnapshots(userId, keepNote) {
  const ofUser = { action: { $in: ['somm_maturity', 'somm_maturity_remove'] }, 'prev.setBy': String(userId) };
  await McpActionLog.updateMany(
    { ...ofUser, 'prev.sommNotes': { $ne: keepNote } },
    { $set: { 'prev.setBy': null, 'prev.setAt': null, 'prev.sommNotes': null } }
  );
  return McpActionLog.updateMany(ofUser, { $set: { 'prev.setBy': null, 'prev.setAt': null } });
}

/**
 * Take an erased member, and the note they wrote, out of the requester list
 * a declined price-tracking request left in its undo snapshot
 * (reject_price_request). Caller: the PriceTrackingRequest entry of
 * services/userDataRegistry. Returns the updateMany result.
 */
function eraseRequesterFromDeclineSnapshots(userId) {
  return McpActionLog.updateMany(
    { action: 'somm_price_decline', 'prev.requesters.user': String(userId) },
    { $pull: { 'prev.requesters': { user: String(userId) } } }
  );
}

module.exports = { eraseCuratorFromWindowSnapshots, eraseRequesterFromDeclineSnapshots };
