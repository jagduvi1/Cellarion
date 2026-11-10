// The fields a correction proposal may change, and how a proposed value is
// read. One set of rules for both doors that file a field correction:
//   - the member path (services/wineProposalOps: the web form, the member's
//     suggest_wine_correction tool and the Registry Bridge);
//   - the sommelier's propose_wine_correction (mcp/tools/somm/corrections.js).
// Approval applies every proposal with the same code
// (services/wineProposalDecisionOps), so a value one door accepts and the
// other refuses is a proposal that fails, or changes nothing, once approved.
//
// The rules are shared, the words are not: a refused read answers
// { ok: false, code, … } with what it is about, and each door says it in its
// own terms. What differs between the doors is passed in: how long a grape
// list may be, and whether the caller may declare a variety the taxonomy
// lacks.
//
// A module of its own with nothing above it: the limits below size the tool
// schemas when the tools load.

const { stripHtml } = require('../utils/sanitize');
const { normalizeString, resolveGrapeName, normalizeClassification } = require('../utils/normalize');
const { WINE_COLOURS } = require('../utils/wineColour');
const { assignClassification } = require('./classificationOps');

/** The plain-text identity fields. */
const TEXT_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
/**
 * The structural fields. `type` is the wine-type enum; `colour` is the colour
 * of a sparkling, dessert or fortified wine; `grapes` REPLACES the whole
 * variety list, and every name must exist in the taxonomy.
 */
const EXTRA_FIELDS = ['type', 'colour', 'grapes'];
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const FIELD_MAX = 200;
const GRAPE_NAME_MAX = 60;
const REASON_MIN = 10;
const REASON_MAX = 1000;
const URL_MAX = 500;

const refused = (code, about = {}) => ({ ok: false, code, ...about });
const plainText = (value) => stripHtml(String(value == null ? '' : value)).trim();

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
 * before approving. Returns { ok: true, names, newNames }, or a refusal:
 * 'new_grapes_list', 'unknown_grapes' { names }, 'implausible_grapes'
 * { names }, 'taxonomy_changed'.
 */
async function resolveProposedGrapes(names, declaredNew, { grapesMax }) {
  const { resolveGrapeIdsStrict } = require('./wineProfileOps');
  // The key the resolver itself dedupes and matches on.
  const keyOf = (n) => normalizeString(resolveGrapeName(n));

  let declared = new Set();
  if (declaredNew !== undefined && declaredNew !== null) {
    if (!Array.isArray(declaredNew) || declaredNew.length > grapesMax) return refused('new_grapes_list');
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
  if (undeclared.length) return refused('unknown_grapes', { names: undeclared });
  const implausible = strict.unmatched.filter((g) => !looksLikeGrapeName(g));
  if (implausible.length) return refused('implausible_grapes', { names: implausible });

  // By the resolver's KEY, not by raw string: it skips a second spelling of a
  // name it has already seen ("Solaris", "solaris" — only the first comes back
  // unmatched), so a raw comparison would read the repeat as a KNOWN variety
  // and the second pass below would fail it as "the taxonomy changed", on
  // every retry.
  const unmatchedKeys = new Set(strict.unmatched.map(keyOf));
  const known = names.filter((n) => { const k = keyOf(n); return !!k && !unmatchedKeys.has(k); });
  let canonical = [];
  if (known.length) {
    const again = await resolveGrapeIdsStrict(known);
    // The taxonomy moved between the two reads — the caller simply retries.
    if (!again.ok) return refused('taxonomy_changed');
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
 * Read the proposed fields of one field correction. `src` is the caller's
 * object, keyed by field; a blank value is a field left alone.
 *
 *   grapesMax    how many varieties this door allows in a list
 *   declaredNew  the varieties the caller says the taxonomy lacks (the member
 *                path's `newGrapes`); leave undefined where a door has none
 *
 * Returns { ok: true, proposedFields, classificationTier, newGrapeNames }.
 * proposedFields holds the canonical value of each field that was sent;
 * classificationTier is the cleaned classification as sent, for
 * settleClassificationByCountry once the wine is loaded. A refusal is one of:
 *   'field_too_long' { field }        'regulatory_mark' { value }
 *   'unknown_tier' { message }        'bad_type'   'bad_colour'
 *   'grapes_list'   'grape_name'      'no_fields'
 *   and what resolveProposedGrapes refuses.
 * Callers: fileFieldCorrection (services/wineProposalOps) and
 * propose_wine_correction (mcp/tools/somm/corrections.js).
 */
async function readProposedFields(src, { grapesMax, declaredNew } = {}) {
  const proposedFields = {};
  let classificationTier = null;
  let newGrapeNames = [];
  for (const f of TEXT_FIELDS) {
    if (src[f] === undefined || src[f] === null) continue;
    const v = plainText(src[f]);
    if (!v) continue;
    if (v.length > FIELD_MAX) return refused('field_too_long', { field: f });
    if (f === 'classification') {
      // A regulatory mark (DOCG, AOC …) is no tier: it would apply as nothing
      // at approval, so it is refused rather than counted as a changed field.
      const tier = normalizeClassification(v);
      if (!tier) return refused('regulatory_mark', { value: v });
      // Resolved against the classification taxonomy at filing, so the filer
      // learns NOW about a tier the registry does not know, and the admin
      // diff shows the canonical names that would be written. The wine is
      // not loaded yet here: a word two systems share is settled by the
      // wine's country in settleClassificationByCountry.
      const cls = await assignClassification({}, { classification: tier, strict: true });
      if (!cls.ok) return refused('unknown_tier', { message: cls.message });
      proposedFields[f] = cls.classification || tier;
      classificationTier = tier;
      continue;
    }
    proposedFields[f] = v;
  }
  if (src.type !== undefined && src.type !== null) {
    const t = String(src.type).trim().toLowerCase();
    if (!WINE_TYPES.includes(t)) return refused('bad_type');
    proposedFields.type = t;
  }
  if (src.colour !== undefined && src.colour !== null) {
    const c = String(src.colour).trim().toLowerCase();
    if (!WINE_COLOURS.includes(c)) return refused('bad_colour');
    proposedFields.colour = c;
  }
  if (src.grapes !== undefined && src.grapes !== null) {
    if (!Array.isArray(src.grapes) || src.grapes.length === 0 || src.grapes.length > grapesMax) return refused('grapes_list');
    const names = src.grapes.map(plainText).filter(Boolean);
    if (names.length === 0 || names.some((n) => n.length > GRAPE_NAME_MAX)) return refused('grape_name');
    const resolved = await resolveProposedGrapes(names, declaredNew, { grapesMax });
    if (!resolved.ok) return resolved;
    // Canonical names, so the admin diff shows what would actually be written
    // (a declared new variety stays as typed — there is no canonical form yet).
    proposedFields.grapes = resolved.names;
    newGrapeNames = resolved.newNames;
  }
  if (Object.keys(proposedFields).length === 0) return refused('no_fields');
  return { ok: true, proposedFields, classificationTier, newGrapeNames };
}

/**
 * A word two tier systems share ("Ortswein" is Austria's tier and a spelling
 * of VDP.Ortswein) resolves in readProposedFields to whichever row came
 * first, and approval applies the filed NAME as it stands. So the tie is
 * broken here, by the wine's country: the country approval resolves in.
 * Rewrites proposedFields.classification in place when the country has its
 * own row. Callers: the two that call readProposedFields.
 */
async function settleClassificationByCountry(proposedFields, classificationTier, wine) {
  if (!classificationTier) return;
  const own = await assignClassification({ country: wine.country }, { classification: classificationTier, strict: true });
  if (own.ok && own.classification) proposedFields.classification = own.classification;
}

module.exports = {
  TEXT_FIELDS,
  EXTRA_FIELDS,
  WINE_TYPES,
  FIELD_MAX,
  GRAPE_NAME_MAX,
  REASON_MIN,
  REASON_MAX,
  URL_MAX,
  readProposedFields,
  settleClassificationByCountry,
};
