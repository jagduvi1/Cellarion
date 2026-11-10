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
 * The one-pending rule is per WINE, not per user (partial unique index on
 * WineCorrectionProposal). A user who notices a second gap right after filing
 * must not be told "already awaiting review" by their own suggestion. So when
 * the pending row is the caller's OWN, a new filing
 * AMENDS it instead of colliding; only somebody else's pending row is a
 * conflict. An amendment enters nothing new into the queue, so it bypasses
 * the daily budget (not the ban) — capped at AMENDMENTS_MAX per proposal so
 * the bypass cannot be farmed. `pendingForWine` exposes the same state to
 * readers (get_wine) so the block is discoverable before a correction is
 * composed.
 *
 * An amendment is ONE atomic update pinned to { pending, this proposer }
 * (audit 2026-09-12 H-1): per-field $set paths, so two amendments of
 * different fields in the same second both land, and never a write onto a
 * row an admin decided in between — that case falls through to a fresh
 * filing, budget applied. The original reason and evidenceUrl are never
 * touched; each amendment is $pushed with its own reason/evidence, and the
 * snapshot is refreshed only for the fields being added, so drift the admin
 * should still see on the original fields survives.
 *
 * Results are transport-neutral: { ok: true, ... } or { ok: false, code,
 * message } — codes: invalid | banned | limit | not_found | conflict.
 */
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { originFrom } = require('../utils/contributionOrigin');

const { findVisibleWine } = require('./wineVisibility');
const { stripHtml } = require('../utils/sanitize');
const { identitySnapshot } = require('../utils/proposalSnapshot');
const { isValidId } = require('../utils/validation');
const { WINE_COLOURS, isStyleType } = require('../utils/wineColour');

const { TIER_DAILY, checkContributionGate } = require('./contributionGate');
const { appliesDirectly, applyCorrectionIfTrusted } = require('./trustedContributions');

// The fields a correction may change, their limits and how a proposed value
// is read are shared with the sommelier's tool (services/proposalFields), so
// the two doors cannot accept different things for the same approval.
const {
  TEXT_FIELDS: FIELDS, EXTRA_FIELDS, WINE_TYPES, FIELD_MAX, GRAPE_NAME_MAX, REASON_MIN, REASON_MAX, URL_MAX,
  readProposedFields, settleClassificationByCountry,
} = require('./proposalFields');
// Not a field but a MODIFIER of `grapes`: the names
// in the grape list the caller asserts are genuinely missing from the taxonomy.
// It rides inside `fields` so every transport that forwards `fields` verbatim
// (the REST route, the Registry Bridge) carries it without a protocol change;
// the MCP tool's schema does not declare it, so an assistant's typo is still
// refused at filing exactly as before. A declared name is kept VERBATIM in the
// proposal — nothing is minted here or at approval, which still refuses an
// unknown variety until an admin has added it to the taxonomy deliberately.
const FIELD_MODIFIERS = ['newGrapes'];
// How many varieties a member's list may hold (a curator's tool allows more).
const GRAPES_MAX = 12;
// Amendments bypass the daily budget (nothing new enters the queue), so they
// are capped per proposal instead — enough for "I noticed three more gaps",
// not enough to farm.
const AMENDMENTS_MAX = 10;

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Create a field_correction proposal from a regular user.
 * fields = { producer?, name?, appellation?, region?, country?, classification? }
 */
/**
 * File a member's field correction — and, on a server that does not review
 * contributions, apply it at once (services/trustedContributions). The
 * answer then carries `applied: true` and the corrected wine.
 */
async function createFieldCorrection(userId, input, opts = {}) {
  const result = await fileFieldCorrection(userId, input, opts);
  return applyCorrectionIfTrusted(result, userId, opts);
}

async function fileFieldCorrection(userId, { wineId, fields, reason, evidenceUrl }, { via, req } = {}) {
  const origin = originFrom(req, via);
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

  const src = fields || {};
  for (const f of Object.keys(src)) {
    if (!FIELDS.includes(f) && !EXTRA_FIELDS.includes(f) && !FIELD_MODIFIERS.includes(f)) {
      return fail('invalid', `Unknown field "${f}" — correctable fields: ${[...FIELDS, ...EXTRA_FIELDS].join(', ')}.`);
    }
  }
  if (src.newGrapes !== undefined && src.newGrapes !== null && (src.grapes === undefined || src.grapes === null)) {
    return fail('invalid', 'newGrapes only qualifies a grapes list — send the complete corrected grapes list with it.');
  }
  // One reading of the proposed values for both doors (services/proposalFields);
  // newGrapeNames are the varieties the caller declared missing from the
  // taxonomy (audit only), classificationTier the cleaned classification as
  // sent, settled by the wine's country once the wine is loaded.
  const read = await readProposedFields(src, { grapesMax: GRAPES_MAX, declaredNew: src.newGrapes });
  if (!read.ok) return fieldFailure(read);
  const { proposedFields, classificationTier, newGrapeNames } = read;

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');

  // Looked up BEFORE the gate so an amendment of the caller's own pending row
  // is not refused as "one more suggestion today" — but acted on only AFTER
  // the visibility check below, so a hidden wine's queue state never leaks.
  let existing = await findPendingForWine(wineId);
  let amending = isOwn(existing, userId);

  // Ban + the ONE daily budget shared across all suggestion families.
  // No daily limit where nobody reviews (services/trustedContributions).
  const gate = await checkContributionGate(userId, { budget: !amending && !appliesDirectly(via) });
  if (!gate.ok) return gate;
  const { user } = gate;
  // Visibility, not ownership: anyone who can SEE the wine may suggest a fix
  // (a pendingIdentity wine stays invisible to strangers, same as everywhere).
  const wine = await findVisibleWine(String(wineId), {
    userId,
    roles: req?.user?.roles || [],
    // noDrafts: a draft is edited directly by its creator; the correction
    // queue is for shared records (draft design 2026-09-12).
    noDrafts: true,
    populate: ['country', 'region', 'grapes'],
  });
  if (!wine) return fail('not_found', 'Wine not found');

  // A word two tier systems share is settled by the wine's country, the
  // country approval resolves in.
  await settleClassificationByCountry(proposedFields, classificationTier, wine);

  // A colour only means something on a style type — judged against the type
  // this suggestion leaves the wine with: its own type field, else the type in
  // the caller's pending suggestion it is amending, else the stored one.
  if (proposedFields.colour) {
    const typeAfter = proposedFields.type
      || (amending ? plain(existing.proposedFields)?.type : null)
      || wine.type
      || null;
    if (!isStyleType(typeAfter)) {
      return fail('invalid',
        `A colour only applies to sparkling, dessert and fortified wines — this wine is ${typeAfter ? `typed ${typeAfter}` : 'not typed yet'}. ` +
        'If the type is wrong, suggest the type in the same suggestion.');
    }
  }

  // The shape the admin diff compares against, shared with the sommelier
  // path and the review route (utils/proposalSnapshot): grapes as joined names.
  const currentSnapshot = identitySnapshot(wine);

  const addendum = { fields: Object.keys(proposedFields), reason: cleanReason, evidenceUrl: cleanUrl };
  const label = `${wine.producer || '?'} — ${wine.name}`;
  const auditMeta = {
    wine: label,
    tier: user.contribution?.tier || 'newcomer',
    ...(via ? { via } : {}),
    ...(newGrapeNames.length ? { newGrapes: newGrapeNames } : {}),
  };

  // Two rounds at most: a round either settles (amend / create / conflict) or
  // learns the queue moved under it (decided or raced) and re-reads once.
  for (let round = 0; round < 2; round++) {
    if (existing && !amending) return fail('conflict', OTHER_USER_CONFLICT);

    if (amending) {
      const amended = await amendOwn(existing, userId, proposedFields, currentSnapshot, addendum);
      if (amended.ok === false) return amended;
      if (amended.proposal) {
        const { logAudit } = require('./audit');
        logAudit(req || null, 'wine_proposal.user_amend',
          { type: 'wine', id: wine._id },
          {
            proposalId: amended.proposal._id,
            fields: addendum.fields,
            allFields: Object.keys(plain(amended.proposal.proposedFields)),
            amendments: (amended.proposal.amendments || []).length,
            ...auditMeta,
          });
        return { ok: true, proposal: amended.proposal, wine, amended: true, amendedFields: addendum.fields };
      }
      // The row was decided while this filing was composed — it is a fresh
      // filing now, and a fresh filing is budgeted.
      const fresh = await checkContributionGate(userId, { budget: !appliesDirectly(via) });
      if (!fresh.ok) return fresh;
      existing = null;
      amending = false;
    }

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
        ...origin,
      });
    } catch (err) {
      // One pending field_correction per wine (partial unique index): a row
      // appeared between the lookup and this insert. Whose it is decides the
      // outcome — the caller's own (a parallel filing of theirs) is amended,
      // never reported as "in the queue" while its fields were dropped
      // (audit 2026-09-12 M-1).
      if (err?.code === 11000) {
        existing = await findPendingForWine(wineId);
        amending = isOwn(existing, userId);
        continue;
      }
      throw err;
    }

    const { logAudit } = require('./audit');
    logAudit(req || null, 'wine_proposal.user_create',
      { type: 'wine', id: wine._id },
      { proposalId: proposal._id, fields: Object.keys(proposedFields), ...auditMeta });

    return { ok: true, proposal, wine, amended: false };
  }

  // Two rounds of the queue moving underneath — vanishingly rare; the caller
  // retries.
  return fail('conflict', 'The suggestion queue for this wine changed while filing — please try again.');
}

// Transport-neutral (the same text reaches the web bottle page and the MCP
// tool); each transport adds its own pointer to where the pending state shows.
const OTHER_USER_CONFLICT =
  'A suggestion for this wine is already awaiting review, filed by another user — the limit is one pending ' +
  'suggestion per wine. Wait for that decision.';

const isOwn = (row, userId) => !!row && String(row.proposer) === String(userId);

const quoted = (names) => names.map((g) => `"${g}"`).join(', ');

/**
 * What a refused reading of the proposed fields (services/proposalFields)
 * says on the member path. Transport-neutral: the same text reaches the web
 * form, the member's MCP tool and the Registry Bridge.
 */
function fieldFailure(refusal) {
  switch (refusal.code) {
    case 'field_too_long':
      return fail('invalid', `${refusal.field} must be at most ${FIELD_MAX} characters.`);
    case 'regulatory_mark':
      return fail('invalid', `"${refusal.value}" is a regulatory mark, not a classification tier — leave classification out, or name the tier (Grand Cru, Premier Cru, Kabinett, Spätlese…).`);
    case 'unknown_tier':
      return fail('invalid', refusal.message);
    case 'bad_type':
      return fail('invalid', `type must be one of ${WINE_TYPES.join(', ')}.`);
    case 'bad_colour':
      return fail('invalid', `colour must be one of ${WINE_COLOURS.join(', ')}.`);
    case 'grapes_list':
      return fail('invalid', `grapes must be a list of 1 to ${GRAPES_MAX} variety names — the complete corrected list, since it replaces the current one.`);
    case 'grape_name':
      return fail('invalid', `Each grape name must be 1 to ${GRAPE_NAME_MAX} characters.`);
    case 'new_grapes_list':
      return fail('invalid', `newGrapes must be a list of at most ${GRAPES_MAX} variety names.`);
    case 'unknown_grapes':
      return fail('invalid',
        `These grape names are not in the taxonomy: ${quoted(refusal.names)}. ` +
        'Check the spelling or use the grape\'s canonical name — a suggestion cannot create a variety.');
    case 'implausible_grapes':
      return fail('invalid',
        `${quoted(refusal.names)} does not look like a grape variety name — ` +
        'leave out percentages and anything that is not the variety itself.');
    case 'taxonomy_changed':
      return fail('conflict', 'The grape taxonomy changed while filing — please try again.');
    default:
      return fail('invalid', 'Suggest at least one changed field.');
  }
}

/**
 * The atomic amendment. Returns { proposal } on success, { proposal: null }
 * when the row is no longer this proposer's pending row (decided meanwhile —
 * the caller files afresh), or a { ok: false } failure.
 */
async function amendOwn(existing, userId, proposedFields, currentSnapshot, addendum) {
  if ((existing.amendments || []).length >= AMENDMENTS_MAX) {
    return fail('limit',
      `Your pending suggestion on this wine has been amended ${AMENDMENTS_MAX} times already — wait for the admin's decision before suggesting more.`);
  }
  const $set = {};
  for (const [k, v] of Object.entries(proposedFields)) $set[`proposedFields.${k}`] = v;
  if (existing.currentSnapshot && typeof existing.currentSnapshot === 'object') {
    // Only the fields being added: drift the admin should still see on the
    // original fields is not erased by a proposer who re-looked at one field.
    for (const k of Object.keys(proposedFields)) $set[`currentSnapshot.${k}`] = currentSnapshot[k];
  } else {
    $set.currentSnapshot = currentSnapshot;
  }
  const updated = await WineCorrectionProposal.findOneAndUpdate(
    { _id: existing._id, status: 'pending', proposer: userId, kind: 'field_correction' },
    {
      $set,
      $push: {
        amendments: {
          at: new Date(),
          fields: addendum.fields,
          reason: addendum.reason,
          ...(addendum.evidenceUrl ? { evidenceUrl: addendum.evidenceUrl } : {}),
        },
      },
    },
    { new: true, runValidators: true, context: 'query' }
  );
  return { proposal: updated || null };
}

/** A mongoose subdoc or a plain object → plain object (never null). */
function plain(v) {
  if (!v) return {};
  return typeof v.toObject === 'function' ? v.toObject() : v;
}

/** The pending field_correction on a wine, as a saveable document, or null. */
function findPendingForWine(wineId) {
  return WineCorrectionProposal.findOne({
    wineDefinition: { $eq: String(wineId) },
    kind: 'field_correction',
    status: 'pending',
  });
}

/**
 * Read-side view of the one-pending-per-wine state, for get_wine and the
 * like: which fields a pending suggestion covers and whether it is the
 * CALLER's (then also when it was filed) — never whose it is otherwise (the
 * #930 anonymisation rule: proposer identity stays with admins). Proposed
 * VALUES are not exposed either: the queue is not a second, unreviewed
 * registry.
 *
 * Returns null when nothing is pending. `userId` may be null (anonymous
 * caller) — then `mine` is false.
 */
async function pendingForWine(wineId, userId) {
  if (!isValidId(String(wineId))) return null;
  const row = await WineCorrectionProposal.findOne({
    wineDefinition: { $eq: String(wineId) },
    kind: 'field_correction',
    status: 'pending',
  }).select('proposer proposedFields createdAt').lean();
  if (!row) return null;
  const fields = Object.entries(plain(row.proposedFields))
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k]) => k);
  const mine = isOwn(row, userId);
  // filed_at only on the caller's own row: another user's filing time is one
  // more attribute of their activity, and the block needs only the fields.
  return { fields, mine, ...(mine ? { filed_at: row.createdAt || null } : {}) };
}

/**
 * pendingForWine for the web bottle page, behind the same visibility rule as
 * filing: a hidden wine's queue state never leaks, so a wine the caller cannot
 * see reads as "nothing pending". This is what lets the page say "another
 * member's suggestion is awaiting review" BEFORE the user has typed a
 * correction that could only come back as a 409.
 */
async function pendingForViewer(userId, wineId, roles = []) {
  if (!isValidId(String(wineId))) return null;
  const wine = await findVisibleWine(String(wineId), { userId, roles, noDrafts: true, select: '_id', lean: true });
  if (!wine) return null;
  return pendingForWine(wineId, userId);
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
    .select('proposedFields status reason rejectReason appliedNote amendments createdAt decidedAt')
    .lean();
  return { ok: true, proposals };
}

module.exports = {
  FIELDS,
  TIER_DAILY,
  REASON_MIN,
  AMENDMENTS_MAX,
  createFieldCorrection,
  listMineForWine,
  pendingForWine,
  pendingForViewer,
};
