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

// Structural RECORD fields a curator may also correct (support ticket
// d4a1aef5: a vin jaune arrived typed "fortified" — a serving/storage hazard
// — and the only field the curator could reach was the prose, which was
// already right). Both are closed vocabularies and neither is a merge/join
// key, which is exactly why they are safe here while producer/name/region/
// appellation are not. They live on the wine document itself, NOT inside
// aiProfile, and touching them alone does not claim the tasting profile was
// verified.
//
// Mirrors the WineDefinition schema enum — pinned by a drift test in
// wineProfileOps.test.js rather than read from the schema at require time,
// because test suites mock the model as a bare object.
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const GRAPES_MAX = 20;      // mirrors findOrCreateWine's MAX_GRAPES cap
const GRAPE_NAME_MAX = 60;
const RECORD_FIELDS = ['type', 'grapes'];

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
  const allFields = [...EDITABLE_FIELDS, ...RECORD_FIELDS];
  const touched = allFields.filter(f => patch[f] !== undefined);
  if (touched.length === 0) {
    return { ok: false, error: `Nothing to update — supply at least one of: ${allFields.join(', ')}` };
  }

  const clean = {};
  for (const field of touched) {
    const value = patch[field];

    if (field === 'type') {
      // Every wine HAS a type (schema enum with a default) — there is no
      // cleared state to return to, so null is a mistake, not an abstention.
      if (value === null) {
        return { ok: false, error: 'type cannot be cleared — pass the corrected value instead' };
      }
      if (typeof value !== 'string' || !WINE_TYPES.includes(value)) {
        return { ok: false, error: `type must be one of: ${WINE_TYPES.join(', ')}` };
      }
      clean.type = value;
      continue;
    }

    if (field === 'grapes') {
      // Validated here as NAMES (shape only); the caller resolves them to
      // taxonomy ids with resolveGrapeIdsStrict before applyProfilePatch.
      if (value === null) { clean.grapes = []; continue; }
      const list = normalizeList(value, { max: GRAPES_MAX, maxLen: GRAPE_NAME_MAX });
      if (list === null) {
        return { ok: false, error: `grapes must be an array of at most ${GRAPES_MAX} variety names, each ≤ ${GRAPE_NAME_MAX} characters (or null to clear)` };
      }
      clean.grapes = list;
      continue;
    }

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

/**
 * Resolve curator-supplied grape variety NAMES to Grape taxonomy ids.
 * MATCH-ONLY, deliberately: synonyms resolve ("Shiraz" finds the Syrah doc,
 * same lookup findOrCreateGrapes uses) but an unknown name is an error, never
 * a new taxonomy row — a typo'd variety from a curation session must fail
 * loudly rather than silently mint junk the whole registry then trusts. A
 * genuinely new variety is an admin taxonomy add first.
 *
 * @param {string[]} names  cleaned names from validateProfilePatch
 * @returns {Promise<{ok:true, ids:any[], names:string[], substitutions:{from:string,to:string}[]}|{ok:false, unmatched:string[]}>}
 *          `names` echoes the CANONICAL display names, for response payloads.
 *          `substitutions` lists every input stored under a DIFFERENT name
 *          (synonym or static-map hop, e.g. "Tinta Roriz" → Tempranillo) —
 *          the write path must SAY when it overrides what the curator typed
 *          (somm ticket 2026-08-11), so callers surface these in responses.
 *          Case/diacritic-only differences are not substitutions.
 */
async function resolveGrapeIdsStrict(names) {
  // Lazy requires, matching the module's load-lean convention: the pure
  // validators above stay importable without the model layer.
  const Grape = require('../models/Grape');
  const { resolveGrapeName, normalizeString } = require('../utils/normalize');
  const ids = [];
  const canonical = [];
  const unmatched = [];
  const substitutions = [];
  const seen = new Set();
  for (const raw of names) {
    const resolved = resolveGrapeName(raw);
    const normalizedName = normalizeString(resolved);
    // A name that normalizes to nothing (non-Latin scripts — normalizeString
    // strips non-ASCII word chars — or a bare percentage) is UNRESOLVABLE, not
    // ignorable: silently dropping it turned a set into a partial write, and an
    // all-such list into an accidental CLEAR of wine.grapes (audit 2026-08-10).
    if (!normalizedName) { unmatched.push(raw); continue; }
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    const grape = await Grape.findOne({
      $or: [{ normalizedName }, { normalizedSynonyms: normalizedName }],
    }).select('_id name').lean();
    if (grape) {
      // Id-level dedupe: two DIFFERENT input names can resolve to one Grape
      // doc via DB synonyms ("Tempranillo" + "Tinta Roriz") — the seen-by-name
      // guard above only catches inputs folding to the same string, so without
      // this the same ObjectId was stored twice. A skipped duplicate records
      // no substitution either: nothing new gets stored under another name.
      if (ids.some((id) => String(id) === String(grape._id))) continue;
      ids.push(grape._id);
      canonical.push(grape.name);
      if (normalizeString(raw) !== normalizeString(grape.name)) {
        substitutions.push({ from: String(raw).trim(), to: grape.name });
      }
    } else {
      unmatched.push(raw);
    }
  }
  return unmatched.length ? { ok: false, unmatched } : { ok: true, ids, names: canonical, substitutions };
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
  // Record fields (may hold populated docs — keep bare ids for the undo).
  snap.type = wine.type || null;
  snap.grapes = Array.isArray(wine.grapes) ? wine.grapes.map((g) => String(g && g._id ? g._id : g)) : [];
  return snap;
}

/**
 * Apply a validated patch to a wine document (does NOT save — the caller owns
 * the transaction boundary and any post-save side effects like re-indexing).
 * If the patch carries `grapes`, the caller must have already swapped the
 * names for taxonomy ids via resolveGrapeIdsStrict — the value here is
 * assigned to wine.grapes verbatim.
 *
 * Provenance (the part that controls enrichment):
 *   - A write that SETS at least one profile value is a curation — it stamps
 *     source='curator' + verifiedBy/At, which permanently exempts the wine
 *     from enrichmentJob, and profileReviewedAt, which clears it from the
 *     admin low-confidence queue (a human looked at exactly what that queue
 *     asks a human to look at).
 *   - A write that ONLY CLEARS profile values is a reset signal — "this is
 *     wrong", not "this is verified". On an AI-sourced profile it clears the
 *     fields and touches NO provenance, so the wine stays eligible for
 *     re-enrichment (support ticket d49ca3af: clearing used to curator-freeze
 *     the wine, locking exactly the worst-sourced rows out of the enrichment
 *     that would have fixed them). On an already-curator profile a clear is
 *     someone editing their own curated data and stays curator.
 *   - Record fields (type/grapes) live outside aiProfile and never claim the
 *     tasting profile was verified.
 */
function applyProfilePatch(wine, clean, userId, { now = new Date() } = {}) {
  if (!wine.aiProfile) wine.aiProfile = {};
  const profileEntries = Object.entries(clean).filter(([f]) => EDITABLE_FIELDS.includes(f));
  for (const [field, value] of profileEntries) {
    wine.aiProfile[field] = value;
  }
  if (clean.type !== undefined) wine.type = clean.type;
  if (clean.grapes !== undefined) wine.grapes = clean.grapes;

  const isClear = (v) => v === null || (Array.isArray(v) && v.length === 0);
  const pureClear = profileEntries.length > 0 && profileEntries.every(([, v]) => isClear(v));
  if (profileEntries.length > 0) {
    if (!pureClear || wine.aiProfile.source === 'curator') {
      wine.aiProfile.source = 'curator';
      wine.aiProfile.verifiedBy = userId || null;
      wine.aiProfile.verifiedAt = now;
      wine.profileReviewedAt = now;
    }
    // Either way the HOLD is over: a real write means a human supplied the
    // truth the hold was waiting for; a pure clear is the documented reset
    // signal ("this is wrong") and returns the wine to the enrichable pool —
    // where, if the model still doubts the identity, it simply holds again.
    wine.aiProfile.heldAt = null;
    wine.markModified('aiProfile');
  }
  return wine;
}

/** Restore a snapshot verbatim (undo). Mirrors applyProfilePatch's surface.
 *  Record fields restore only when the snapshot carries them — ledger rows
 *  written before type/grapes existed must not null a wine's type. */
function restoreProfile(wine, snap) {
  if (!wine.aiProfile) wine.aiProfile = {};
  for (const f of EDITABLE_FIELDS) {
    wine.aiProfile[f] = Array.isArray(snap[f]) ? [...snap[f]] : (snap[f] ?? null);
  }
  wine.aiProfile.source = snap.source || 'ai';
  wine.aiProfile.verifiedBy = snap.verifiedBy || null;
  wine.aiProfile.verifiedAt = snap.verifiedAt || null;
  wine.profileReviewedAt = snap.profileReviewedAt || null;
  if (typeof snap.type === 'string' && snap.type) wine.type = snap.type;
  if (Array.isArray(snap.grapes)) wine.grapes = [...snap.grapes];
  wine.markModified('aiProfile');
  return wine;
}

module.exports = {
  PROFILE_ENUMS,
  LIST_FIELDS,
  EDITABLE_FIELDS,
  RECORD_FIELDS,
  WINE_TYPES,
  GRAPES_MAX,
  GRAPE_NAME_MAX,
  DESCRIPTION_MAX,
  validateProfilePatch,
  resolveGrapeIdsStrict,
  applyProfilePatch,
  snapshotProfile,
  restoreProfile,
};
