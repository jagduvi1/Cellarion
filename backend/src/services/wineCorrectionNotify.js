/**
 * Telling a submitter what became of their wine correction — shared by every
 * place a correction gets DECIDED, so none of them can forget:
 *   - routes/admin/wineProposals.js   an admin approves or rejects it
 *   - routes/admin/wines.js           the wine is merged away or deleted and
 *                                     its pending corrections close with it
 *
 * The second group is why this is a service (pre-deploy audit 2026-09-18): the
 * bottle page promises "we'll notify you when a curator has decided", and a
 * correction that makes a wine collide with its twin ends in exactly that
 * merge — auto-rejected by a bare updateMany, with nobody told, and invisible
 * on the web too because the bottle now points at the keeper.
 *
 * Only the USER pipeline (services/wineProposalOps stamps `via` on every row
 * it files — web, connector or bridge). A sommelier's own proposals are filed
 * without one and decided in batches of a hundred; a notification per row
 * would bury that account's inbox under its own work. Rows filed by users
 * before `via` existed (2026-09-08) carry none either and stay silent. And
 * never for a decision on one's own proposal.
 *
 * Fire-and-forget, like every notify call: a notification failure must never
 * undo — or even surface as the failure of — a recorded decision.
 */
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { createNotification } = require('./notifications');

// What a submitter calls each correctable field.
const FIELD_WORDS = {
  producer: 'producer', name: 'wine name', appellation: 'appellation', region: 'region',
  country: 'country', classification: 'classification', type: 'type', grapes: 'grapes',
};

const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : (v || {}));

/**
 * @param {object} proposal   the decided row ({ kind, via, proposer, proposedFields })
 * @param {object|null} wine  { _id?, producer, name } — labels the message; `_id`
 *                            (when set) is where the notification links to
 * @param {*} deciderId       who decided (null for lifecycle closure)
 * @param {boolean} approved
 * @param {string} [reason]   shown under a "not applied" message
 */
function notifyProposer(proposal, wine, deciderId, approved, reason) {
  if (!proposal || proposal.kind !== 'field_correction' || !proposal.via || !proposal.proposer) return;
  if (deciderId && String(proposal.proposer) === String(deciderId)) return;
  const pf = plain(proposal.proposedFields);
  const fields = Object.keys(pf)
    .filter((f) => FIELD_WORDS[f] && pf[f] !== undefined && pf[f] !== null && pf[f] !== '' && !(Array.isArray(pf[f]) && !pf[f].length))
    .map((f) => FIELD_WORDS[f]);
  const what = fields.length ? ` (${fields.join(', ')})` : '';
  const label = wine ? ([wine.producer, wine.name].filter(Boolean).join(' — ') || 'a wine') : 'a wine';
  const message = approved
    ? `Your suggested fix for ${label}${what} is now live in the registry. Thank you for improving it.`
    : `Your suggested fix for ${label}${what} was not applied.${reason ? `\n\n${reason}` : ''}`;
  Promise.resolve()
    .then(() => createNotification(
      proposal.proposer,
      'wine_correction_decided',
      approved ? 'Wine correction applied' : 'Wine correction not applied',
      message,
      wine && wine._id ? `/wines/${wine._id}` : null
    ))
    .catch((err) => {
      console.warn('[wineCorrectionNotify] decision notification failed (non-fatal):', err.message);
    });
}

/**
 * Lifecycle closure: reject every PENDING proposal on (or targeting) a wine
 * that is going away, and tell the user-pipeline submitters why. `decidedBy`
 * stays null — this is closure, not a reviewer's judgement.
 *
 * The submitters are read BEFORE the update (afterwards the rows are just
 * rejected rows); a lookup failure costs the notifications, never the closure.
 *
 * @param {*} wineId          the wine going away
 * @param {string} rejectReason
 * @param {object} [opts]
 * @param {object} [opts.wine]   { producer, name } of the wine going away — the label
 * @param {*} [opts.linkWineId]  where the notification links (the merge keeper); none for a delete
 * @param {*} [opts.actorId]     the admin doing it — not told about their own proposal
 */
async function closePendingForWine(wineId, rejectReason, { wine = null, linkWineId = null, actorId = null } = {}) {
  const filter = { status: 'pending', $or: [{ wineDefinition: wineId }, { mergeTargetId: wineId }] };
  let toTell = [];
  try {
    toTell = await WineCorrectionProposal.find({ ...filter, kind: 'field_correction', via: { $ne: null } })
      .select('proposer proposedFields kind via').lean();
  } catch (err) {
    console.warn('[wineCorrectionNotify] could not read submitters before closure (non-fatal):', err.message);
  }
  const result = await WineCorrectionProposal.updateMany(
    filter,
    { $set: { status: 'rejected', decidedAt: new Date(), rejectReason } }
  );
  const labelled = { ...(linkWineId ? { _id: linkWineId } : {}), producer: wine?.producer || null, name: wine?.name || null };
  for (const p of toTell) notifyProposer(p, labelled, actorId, false, rejectReason);
  return result;
}

module.exports = { notifyProposer, closePendingForWine, FIELD_WORDS };
