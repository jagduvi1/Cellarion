/**
 * Curator edits to a wine's tasting profile (WineDefinition.aiProfile).
 *
 * Why this exists (support ticket 2026-07-28): the AI enrichment generator
 * writes confident prose for wines it only half-knows rather than abstaining —
 * a Sandeman Vintage Port was described as "built for immediate drinking",
 * which inverts the single most important fact about the style. A sommelier
 * working the maturity queue is already researching that wine's drink window,
 * so they are the right person to correct the profile, and correcting it in
 * the same pass is the difference between the fix landing and the curator
 * silently working around bad data forever.
 *
 * THE one implementation, shared by the REST route (routes/somm/wineProfile.js)
 * and the MCP tool (mcp/tools/somm.js set_wine_profile) so the two surfaces
 * cannot drift on validation, provenance or the undo snapshot — the same
 * reason bottleOps/rackOps exist.
 *
 * A curator edit sets aiProfile.source='curator', which enrichmentJob filters
 * out of BOTH its modes: the correction is permanent until another human
 * changes it.
 */

const { stripMarkdown } = require('../utils/stripMarkdown');

// Mirrors the value sets the enrichment prompt is told to emit
// (config/aiConfig.js) — an editable field must not accept a value the
// generator itself could never produce, or the UI's pickers and the embedding
// text drift apart.
const PROFILE_ENUMS = {
  body:      ['light', 'medium', 'full'],
  tannin:    ['low', 'medium', 'high'],
  acidity:   ['low', 'medium', 'high'],
  sweetness: ['dry', 'off-dry', 'sweet'],
};

const LIST_FIELDS = {
  flavors:      { max: 10, maxLen: 40 },
  foodPairings: { max: 8,  maxLen: 60 },
};

const DESCRIPTION_MAX = 1000;

/** Every field a curator may write. confidence/model/generatedAt are NOT here:
 *  they describe the generator's run, and a hand-written profile has no
 *  meaningful model confidence. producerSuspect/producerNote stay AI-owned too
 *  — they feed the separate admin low-confidence queue. */
const EDITABLE_FIELDS = [
  ...Object.keys(PROFILE_ENUMS),
  ...Object.keys(LIST_FIELDS),
  'description',
];

function normalizeList(raw, { max, maxLen }) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const v = item.trim().replace(/\s+/g, ' ');
    if (!v) continue;
    if (v.length > maxLen) return null;
    const key = v.toLowerCase();
    if (seen.has(key)) continue; // a curator pasting a list shouldn't create dupes
    seen.add(key);
    out.push(v);
    if (out.length > max) return null;
  }
  return out;
}

/**
 * Validate a patch and return the cleaned values.
 *
 * Absent key = leave the field alone. Explicit null = clear it. That
 * distinction is the point: the ticket asks for FIELD-LEVEL abstention, so a
 * curator must be able to null the prose they don't trust while keeping the
 * structured descriptors that are correct (and that, unlike the prose, feed
 * the embedding text).
 *
 * @param {object} patch - raw input, already parsed from JSON
 * @returns {{ok: true, clean: object}|{ok: false, error: string}}
 */
function validateProfilePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Profile patch must be an object' };
  }
  const touched = EDITABLE_FIELDS.filter(f => patch[f] !== undefined);
  if (touched.length === 0) {
    return { ok: false, error: `Nothing to update — supply at least one of: ${EDITABLE_FIELDS.join(', ')}` };
  }

  const clean = {};
  for (const field of touched) {
    const value = patch[field];

    if (value === null) { clean[field] = field in LIST_FIELDS ? [] : null; continue; }

    if (field in PROFILE_ENUMS) {
      if (typeof value !== 'string' || !PROFILE_ENUMS[field].includes(value)) {
        return { ok: false, error: `${field} must be one of: ${PROFILE_ENUMS[field].join(', ')} (or null)` };
      }
      clean[field] = value;
      continue;
    }

    if (field in LIST_FIELDS) {
      const list = normalizeList(value, LIST_FIELDS[field]);
      if (list === null) {
        const { max, maxLen } = LIST_FIELDS[field];
        return { ok: false, error: `${field} must be an array of at most ${max} strings, each ≤ ${maxLen} characters` };
      }
      clean[field] = list;
      continue;
    }

    // description
    if (typeof value !== 'string') {
      return { ok: false, error: 'description must be a string (or null)' };
    }
    // Strip markdown at the write point for the same reason enrichmentJob does:
    // this string is served verbatim by MCP get_wine and by surfaces that do
    // not render markdown, so emphasis leaks as literal asterisks.
    const text = stripMarkdown(value).trim();
    if (text.length > DESCRIPTION_MAX) {
      return { ok: false, error: `description must be ${DESCRIPTION_MAX} characters or fewer` };
    }
    clean[field] = text || null;
  }

  return { ok: true, clean };
}

/** The fields an undo needs to put back, captured before mutation. */
function snapshotProfile(wine) {
  const ap = wine.aiProfile || {};
  const snap = {};
  for (const f of EDITABLE_FIELDS) {
    const v = ap[f];
    snap[f] = Array.isArray(v) ? [...v] : (v ?? null);
  }
  snap.source = ap.source || 'ai';
  snap.verifiedBy = ap.verifiedBy ? String(ap.verifiedBy) : null;
  snap.verifiedAt = ap.verifiedAt || null;
  snap.profileReviewedAt = wine.profileReviewedAt || null;
  return snap;
}

/**
 * Apply a validated patch to a wine document (does NOT save — the caller owns
 * the transaction boundary and any post-save side effects like re-indexing).
 *
 * Marking the row curator-sourced also clears it from the admin low-confidence
 * queue: profileReviewedAt is set, because a human has now looked at exactly
 * the thing that queue asks a human to look at.
 */
function applyProfilePatch(wine, clean, userId, { now = new Date() } = {}) {
  if (!wine.aiProfile) wine.aiProfile = {};
  for (const [field, value] of Object.entries(clean)) {
    wine.aiProfile[field] = value;
  }
  wine.aiProfile.source = 'curator';
  wine.aiProfile.verifiedBy = userId || null;
  wine.aiProfile.verifiedAt = now;
  wine.profileReviewedAt = now;
  wine.markModified('aiProfile');
  return wine;
}

/** Restore a snapshot verbatim (undo). Mirrors applyProfilePatch's surface. */
function restoreProfile(wine, snap) {
  if (!wine.aiProfile) wine.aiProfile = {};
  for (const f of EDITABLE_FIELDS) {
    wine.aiProfile[f] = Array.isArray(snap[f]) ? [...snap[f]] : (snap[f] ?? null);
  }
  wine.aiProfile.source = snap.source || 'ai';
  wine.aiProfile.verifiedBy = snap.verifiedBy || null;
  wine.aiProfile.verifiedAt = snap.verifiedAt || null;
  wine.profileReviewedAt = snap.profileReviewedAt || null;
  wine.markModified('aiProfile');
  return wine;
}

module.exports = {
  PROFILE_ENUMS,
  LIST_FIELDS,
  EDITABLE_FIELDS,
  DESCRIPTION_MAX,
  validateProfilePatch,
  applyProfilePatch,
  snapshotProfile,
  restoreProfile,
};
