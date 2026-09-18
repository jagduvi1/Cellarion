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
 * WineCorrectionProposal). Support ticket 2026-09-12: a user who noticed a
 * second gap right after filing was told "already awaiting review" — by their
 * own suggestion. So when the pending row is the caller's OWN, a new filing
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
const { isValidId } = require('../utils/validation');

const { TIER_DAILY, checkContributionGate } = require('./contributionGate');

const FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
// Structural fields a user may also correct (support ticket 2026-09-06: the
// sommelier tool had them since 6a85ad44, the user tool did not — a whole
// class of registry errors, wrong grape lists, was unfixable from a connector).
// `type` is validated against the wine-type enum; `grapes` REPLACES the whole
// variety list and every name must already exist in the taxonomy — resolved
// at filing so the user learns about a typo now, and again at approval.
const EXTRA_FIELDS = ['type', 'grapes'];
// Not a field but a MODIFIER of `grapes` (support ticket 2026-09-17): the names
// in the grape list the caller asserts are genuinely missing from the taxonomy.
// It rides inside `fields` so every transport that forwards `fields` verbatim
// (the REST route, the Registry Bridge) carries it without a protocol change;
// the MCP tool's schema does not declare it, so an assistant's typo is still
// refused at filing exactly as before. A declared name is kept VERBATIM in the
// proposal — nothing is minted here or at approval, which still refuses an
// unknown variety until an admin has added it to the taxonomy deliberately.
const FIELD_MODIFIERS = ['newGrapes'];
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const GRAPES_MAX = 12;
const GRAPE_NAME_MAX = 60;
const REASON_MIN = 10;
const REASON_MAX = 1000;
// Amendments bypass the daily budget (nothing new enters the queue), so they
// are capped per proposal instead — enough for "I noticed three more gaps",
// not enough to farm.
const AMENDMENTS_MAX = 10;
const FIELD_MAX = 200;
const URL_MAX = 500;

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Create a field_correction proposal from a regular user.
 * fields = { producer?, name?, appellation?, region?, country?, classification? }
 */
async function createFieldCorrection(userId, { wineId, fields, reason, evidenceUrl }, { via, req } = {}) {
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

  const proposedFields = {};
  // Varieties the caller declared missing from the taxonomy — audit only.
  let newGrapeNames = [];
  const src = fields || {};
  for (const f of Object.keys(src)) {
    if (!FIELDS.includes(f) && !EXTRA_FIELDS.includes(f) && !FIELD_MODIFIERS.includes(f)) {
      return fail('invalid', `Unknown field "${f}" — correctable fields: ${[...FIELDS, ...EXTRA_FIELDS].join(', ')}.`);
    }
  }
  if (src.newGrapes !== undefined && src.newGrapes !== null && (src.grapes === undefined || src.grapes === null)) {
    return fail('invalid', 'newGrapes only qualifies a grapes list — send the complete corrected grapes list with it.');
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
  if (src.type !== undefined && src.type !== null) {
    const t = String(src.type).trim().toLowerCase();
    if (!WINE_TYPES.includes(t)) {
      return fail('invalid', `type must be one of ${WINE_TYPES.join(', ')}.`);
    }
    proposedFields.type = t;
  }
  if (src.grapes !== undefined && src.grapes !== null) {
    if (!Array.isArray(src.grapes) || src.grapes.length === 0 || src.grapes.length > GRAPES_MAX) {
      return fail('invalid', `grapes must be a list of 1 to ${GRAPES_MAX} variety names — the complete corrected list, since it replaces the current one.`);
    }
    const names = src.grapes.map((g) => stripHtml(String(g == null ? '' : g)).trim()).filter(Boolean);
    if (names.length === 0 || names.some((n) => n.length > GRAPE_NAME_MAX)) {
      return fail('invalid', `Each grape name must be 1 to ${GRAPE_NAME_MAX} characters.`);
    }
    const resolved = await resolveProposedGrapes(names, src.newGrapes);
    if (!resolved.ok) return resolved;
    // Canonical names, so the admin diff shows what would actually be written
    // (a declared new variety stays as typed — there is no canonical form yet).
    proposedFields.grapes = resolved.names;
    newGrapeNames = resolved.newNames;
  }
  if (Object.keys(proposedFields).length === 0) {
    return fail('invalid', 'Suggest at least one changed field.');
  }

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');

  // Looked up BEFORE the gate so an amendment of the caller's own pending row
  // is not refused as "one more suggestion today" — but acted on only AFTER
  // the visibility check below, so a hidden wine's queue state never leaks.
  let existing = await findPendingForWine(wineId);
  let amending = isOwn(existing, userId);

  // Ban + the ONE daily budget shared across all suggestion families.
  const gate = await checkContributionGate(userId, { budget: !amending });
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

  const currentSnapshot = {
    producer: wine.producer || null,
    name: wine.name || null,
    appellation: wine.appellation || null,
    region: wine.region?.name || null,
    country: wine.country?.name || null,
    classification: wine.classification || null,
    type: wine.type || null,
    // Joined names, the shape the admin diff compares against (its liveIdentity
    // and the somm path both join) — an array here rendered as permanent drift.
    grapes: (wine.grapes || []).map((g) => (g && g.name) || String(g)).filter(Boolean).join(', ') || null,
  };

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
      const fresh = await checkContributionGate(userId);
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

// A deliberately-new variety is still a NAME: it starts with a letter or digit
// and carries nothing but letters, digits and the punctuation real variety
// names use ("Rkatsiteli", "Müller-Thurgau", "VB 32-7", "Pinot Meunier (Auxerrois)").
// That refuses the shapes that polluted the taxonomy before the review gate —
// "60% Merlot", "Merlot & Cabernet" — and, by length, a pasted sentence: the
// longest real name runs to five words ("Muscat Blanc à Petits Grains").
const NEW_GRAPE_NAME = /^[\p{L}\d][\p{L}\p{M}\d .'’()/-]*$/u;
const NEW_GRAPE_MAX_WORDS = 5;
const looksLikeGrapeName = (s) => NEW_GRAPE_NAME.test(s)
  && (s.match(/\p{L}/gu) || []).length >= 2
  && s.trim().split(/\s+/).length <= NEW_GRAPE_MAX_WORDS;

/**
 * Resolve a proposed grape list against the taxonomy. Every name must match a
 * variety (by name or synonym) EXCEPT the ones the caller declared in
 * `declaredNew`: those are kept as typed, for an admin to add to the taxonomy
 * before approving. Returns { ok: true, names, newNames } or a fail().
 */
async function resolveProposedGrapes(names, declaredNew) {
  const { resolveGrapeIdsStrict } = require('./wineProfileOps');
  const { normalizeString } = require('../utils/normalize');

  let declared = new Set();
  if (declaredNew !== undefined && declaredNew !== null) {
    if (!Array.isArray(declaredNew) || declaredNew.length > GRAPES_MAX) {
      return fail('invalid', `newGrapes must be a list of at most ${GRAPES_MAX} variety names.`);
    }
    declared = new Set(
      declaredNew.map((g) => normalizeString(stripHtml(String(g == null ? '' : g)))).filter(Boolean)
    );
  }

  const strict = await resolveGrapeIdsStrict(names);
  // Declaring a name that IS in the taxonomy costs nothing: it resolves.
  if (strict.ok) return { ok: true, names: strict.names, newNames: [] };

  // A name that normalizes to nothing (non-Latin script) can never be declared:
  // it could not be matched or deduplicated later either.
  const undeclared = strict.unmatched.filter((g) => !declared.has(normalizeString(g)));
  if (undeclared.length) {
    return fail('invalid',
      `These grape names are not in the taxonomy: ${undeclared.map((g) => `"${g}"`).join(', ')}. ` +
      'Check the spelling or use the grape\'s canonical name — a suggestion cannot create a variety.');
  }
  const implausible = strict.unmatched.filter((g) => !looksLikeGrapeName(g));
  if (implausible.length) {
    return fail('invalid',
      `${implausible.map((g) => `"${g}"`).join(', ')} does not look like a grape variety name — ` +
      'leave out percentages and anything that is not the variety itself.');
  }

  const unmatched = new Set(strict.unmatched);
  const known = names.filter((n) => !unmatched.has(n));
  let canonical = [];
  if (known.length) {
    const again = await resolveGrapeIdsStrict(known);
    // The taxonomy moved between the two reads — the caller simply retries.
    if (!again.ok) return fail('conflict', 'The grape taxonomy changed while filing — please try again.');
    canonical = again.names;
  }
  const seen = new Set(canonical.map((n) => normalizeString(n)));
  const newNames = [];
  for (const raw of strict.unmatched) {
    const clean = raw.replace(/\s+/g, ' ').trim();
    const key = normalizeString(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    newNames.push(clean);
  }
  return { ok: true, names: [...canonical, ...newNames], newNames };
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
