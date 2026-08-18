/**
 * The ONE contributor gate for community suggestions (#985): discussion-ban
 * check + the per-tier daily budget, counted across ALL suggestion
 * collections — wine corrections, registry key proposals and registry value
 * suggestions share a single pool, so "your daily limit" means one number
 * everywhere (the MCP tool descriptions promise exactly this).
 *
 * Extracted from wineProposalOps/registryDataOps after the 2026-08-17 audit
 * found three drifting copies and a shared-budget claim the code didn't keep.
 */
const User = require('../models/User');

// Daily suggestion budget per contribution tier (User.contribution.tier).
// Proven contributors fast-track; new accounts cannot swamp the queues.
const TIER_DAILY = {
  newcomer: 3,
  contributor: 5,
  enthusiast: 10,
  connoisseur: 20,
  ambassador: 30,
};

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Load the user and apply ban + budget. Returns { ok: true, user } or the
 * transport-neutral failure the ops services already speak.
 */
async function checkContributionGate(userId) {
  const user = await User.findById(userId).select('contribution.tier discussionBan username');
  if (!user) return fail('not_found', 'User not found');
  if (user.isDiscussionBanned && user.isDiscussionBanned()) {
    return fail('banned', 'You are banned from posting content visible to other users');
  }

  const daily = TIER_DAILY[user.contribution?.tier] || TIER_DAILY.newcomer;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Lazy-require to keep this module cycle-free (both ops services require it).
  const WineCorrectionProposal = require('../models/WineCorrectionProposal');
  const RegistryDataKey = require('../models/RegistryDataKey');
  const RegistryDataValue = require('../models/RegistryDataValue');
  const [corrections, keys, values] = await Promise.all([
    WineCorrectionProposal.countDocuments({ proposer: userId, createdAt: { $gt: since } }),
    RegistryDataKey.countDocuments({ proposedBy: userId, createdAt: { $gt: since } }),
    RegistryDataValue.countDocuments({ suggestedBy: userId, createdAt: { $gt: since } }),
  ]);
  if (corrections + keys + values >= daily) {
    return fail('limit', `You have reached today's suggestion limit (${daily}). Suggestions are reviewed by a human — the limit rises as your accepted contributions grow.`);
  }

  return { ok: true, user };
}

module.exports = { TIER_DAILY, checkContributionGate };
