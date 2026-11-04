/**
 * A server that does not review contributions (config/contributionReview
 * switched off — a household on its own install, discussion #1778) applies
 * each one as it is made, through the very code an admin's approval runs, so
 * the result is the same as an approval: the photo published (and the wine's
 * picture when it has none), the value published, the field accepted, the
 * correction applied. Nobody is notified of a decision nobody made, and the
 * daily suggestion limit — there because a human reads every suggestion —
 * does not apply.
 *
 * Contributions relayed from ANOTHER server over the Registry Bridge
 * (via 'bridge') are that server's members', not this one's: they always
 * wait, limit included. A correction that needs a human choice (a producer
 * spelled two ways) also waits, exactly as it would for an admin.
 */
const contributionReview = require('../config/contributionReview');

/** True when a contribution arriving through `via` is applied as made. */
function appliesDirectly(via) {
  return !contributionReview.isOn() && via !== 'bridge';
}

/**
 * Publish a member's photo once it is ready (processed) and on a bottle or a
 * wine, when this server does not review photos. Called where a photo
 * settles: the upload of a keep-background photo, the end of background
 * removal, and the link of a photo uploaded before its bottle existed.
 * `req` (the member's request, when there is one) names them in the audit
 * row; the background hooks have none, so the uploader is named instead.
 * Never throws; returns whether it published.
 */
async function approvePhotoIfTrusted(imageId, req) {
  if (!appliesDirectly()) return false;
  try {
    const BottleImage = require('../models/BottleImage');
    const image = await BottleImage.findById(imageId).select('status kind bottle wineDefinition uploadedBy').lean();
    if (!image || image.kind === 'label-scan' || image.status !== 'processed') return false;
    if (!image.bottle && !image.wineDefinition) return false; // linked later; published then
    const { approveImage } = require('./imageModerationOps');
    const asReq = req && req.user ? req : { user: { id: String(image.uploadedBy), roles: ['user'] } };
    const out = await approveImage({
      imageId, actorId: image.uploadedBy, visibility: 'public', official: 'auto', notify: false, via: 'unreviewed', req: asReq,
    });
    return !!out.ok;
  } catch (err) {
    console.error(`[trustedContributions] could not publish photo ${imageId}:`, err.message);
    return false;
  }
}

/**
 * Apply a just-filed field correction (wineProposalOps result) when this
 * server does not review: approveProposal, the admin route's own machinery,
 * decided by the member who filed it. Returns the result with the applied
 * proposal and wine, or unchanged when it stays pending (review on, a bridge
 * relay, or a choice approveProposal leaves to a human).
 */
async function applyCorrectionIfTrusted(result, userId, { via, req } = {}) {
  if (!result?.ok || !result.proposal || !appliesDirectly(via)) return result;
  try {
    // Lazy: the admin route tree requires much of the app back.
    const { approveProposal } = require('../routes/admin/wineProposals');
    const asReq = req && req.user ? req : { user: { id: String(userId), roles: ['user'] } };
    const outcome = await approveProposal(result.proposal._id, asReq);
    if (outcome.status !== 200) return result;
    const WineCorrectionProposal = require('../models/WineCorrectionProposal');
    const WineDefinition = require('../models/WineDefinition');
    const [proposal, wine] = await Promise.all([
      WineCorrectionProposal.findById(result.proposal._id).lean(),
      WineDefinition.findById(result.wine?._id || result.proposal.wineDefinition).lean(),
    ]);
    return { ...result, proposal: proposal || result.proposal, wine: wine || result.wine, applied: true, appliedNote: outcome.body?.appliedNote || null };
  } catch (err) {
    console.error(`[trustedContributions] could not apply correction ${result.proposal._id}:`, err.message);
    return result;
  }
}

module.exports = { appliesDirectly, approvePhotoIfTrusted, applyCorrectionIfTrusted };
