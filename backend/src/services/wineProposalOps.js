/**
 * User-facing wine-correction proposals (#985 Slice A) — ONE implementation
 * shared by the REST route (routes/wineProposals.js) and the MCP tool
 * suggest_wine_correction (mcp/tools/corrections.js), the ownerInquiryOps /
 * personalData pattern.
 *
 * This is the regular-user half of the proposal system: field corrections
 * only (merge / non-wine stay sommelier tools — mcp/tools/somm.js), filed
 * into the SAME WineCorrectionProposal queue the admin already reviews with
 * diff + bulk tooling. Suggestions never auto-apply; approval stays human.
 *
 * Gating (issue #985): demo exclusion is the transport's job (requireNonDemo /
 * MCP's no-token rule); HERE lives the shared part — discussion ban, the
 * per-contribution-tier daily budget, and the one-pending-per-wine conflict.
 *
 * Results are transport-neutral: { ok: true, ... } or { ok: false, code,
 * message } — codes: invalid | banned | limit | not_found | conflict.
 */
const WineCorrectionProposal = require('../models/WineCorrectionProposal');

const { findVisibleWine } = require('./wineVisibility');
const { stripHtml } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');

const { TIER_DAILY, checkContributionGate } = require('./contributionGate');

const FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
const REASON_MIN = 10;
const REASON_MAX = 1000;
const FIELD_MAX = 200;
const URL_MAX = 500;

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Create a field_correction proposal from a regular user.
 * fields = { producer?, name?, appellation?, region?, country?, classification? }
 */
async function createFieldCorrection(userId, { wineId, fields, reason, evidenceUrl }, { via, req } = {}) {
  const cleanReason = stripHtml(typeof reason === 'string' ? reason : '').trim();
  if (cleanReason.length < REASON_MIN) {
    return fail('invalid', `Please say what is wrong and how you know — at least ${REASON_MIN} characters.`);
  }
  if (cleanReason.length > REASON_MAX) {
    return fail('invalid', `Reason must be at most ${REASON_MAX} characters.`);
  }

  let cleanUrl = '';
  if (evidenceUrl !== undefined && evidenceUrl !== null) {
    cleanUrl = String(evidenceUrl).trim();
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      return fail('invalid', 'The evidence link must be an http:// or https:// URL.');
    }
    if (cleanUrl.length > URL_MAX) {
      return fail('invalid', `The evidence link must be at most ${URL_MAX} characters.`);
    }
  }

  const proposedFields = {};
  const src = fields || {};
  for (const f of Object.keys(src)) {
    if (!FIELDS.includes(f)) {
      return fail('invalid', `Unknown field "${f}" — correctable fields: ${FIELDS.join(', ')}.`);
    }
  }
  for (const f of FIELDS) {
    if (src[f] === undefined || src[f] === null) continue;
    const v = stripHtml(String(src[f])).trim();
    if (!v) continue;
    if (v.length > FIELD_MAX) {
      return fail('invalid', `${f} must be at most ${FIELD_MAX} characters.`);
    }
    proposedFields[f] = v;
  }
  if (Object.keys(proposedFields).length === 0) {
    return fail('invalid', 'Suggest at least one changed field.');
  }

  // Ban + the ONE daily budget shared across all suggestion families.
  const gate = await checkContributionGate(userId);
  if (!gate.ok) return gate;
  const { user } = gate;

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  // Visibility, not ownership: anyone who can SEE the wine may suggest a fix
  // (a pendingIdentity wine stays invisible to strangers, same as everywhere).
  const wine = await findVisibleWine(String(wineId), {
    userId,
    roles: req?.user?.roles || [],
    populate: ['country', 'region'],
  });
  if (!wine) return fail('not_found', 'Wine not found');

  const currentSnapshot = {
    producer: wine.producer || null,
    name: wine.name || null,
    appellation: wine.appellation || null,
    region: wine.region?.name || null,
    country: wine.country?.name || null,
    classification: wine.classification || null,
  };

  let proposal;
  try {
    proposal = await WineCorrectionProposal.create({
      proposer: userId,
      wineDefinition: wine._id,
      kind: 'field_correction',
      proposedFields,
      ...(cleanUrl ? { evidenceUrl: cleanUrl } : {}),
      reason: cleanReason,
      currentSnapshot,
    });
  } catch (err) {
    // One pending field_correction per wine (partial unique index) — a clean,
    // human answer instead of a stack trace.
    if (err?.code === 11000) {
      return fail('conflict', 'A suggestion for this wine is already awaiting review — thank you, it is in the queue.');
    }
    throw err;
  }

  const { logAudit } = require('./audit');
  logAudit(req || null, 'wine_proposal.user_create',
    { type: 'wine', id: wine._id },
    {
      proposalId: proposal._id,
      fields: Object.keys(proposedFields),
      wine: `${wine.producer || '?'} — ${wine.name}`,
      tier: user.contribution?.tier || 'newcomer',
      ...(via ? { via } : {}),
    });

  return { ok: true, proposal, wine };
}

/**
 * The caller's own proposals on one wine (pending + decided), newest first —
 * what lets the bottle page show "suggestion pending" / the outcome.
 */
async function listMineForWine(userId, wineId) {
  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const proposals = await WineCorrectionProposal.find({
    proposer: userId,
    wineDefinition: { $eq: String(wineId) },
    kind: 'field_correction',
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .select('proposedFields status reason rejectReason appliedNote createdAt decidedAt')
    .lean();
  return { ok: true, proposals };
}

module.exports = {
  FIELDS,
  TIER_DAILY,
  REASON_MIN,
  createFieldCorrection,
  listMineForWine,
};
