/**
 * Which curator corrections may apply themselves, and which still need an
 * admin (2026-08-21).
 *
 * WHY. Every identity correction used to wait for an admin click. Measured over
 * one full curation day: 16 proposals filed, ONE needed the gate. The other
 * fifteen were lookups ("Barolo by Cà di Bruno is in Piedmont") that spent the
 * scarcest resource in the loop — the admin's attention — and, worse,
 * serialised the curator behind it. They finished a block and idled waiting for
 * a review round trip while 231 new wines arrived from a single import the same
 * morning. The gate was not wrong; it was priced wrong.
 *
 * THE LINE IS REVERSIBILITY, NOT TRUST. A proposal applies itself only when it
 * FILLS A BLANK on a field that can be edited back:
 *
 *   appellation / region / classification, each currently empty
 *
 * Everything else keeps the admin gate, for reasons that are specific rather
 * than cautious:
 *   - producer / name  drive normalizedKey and the public URL, and are the
 *                      class with measured failures (5 curator assertions
 *                      overturned by web verification, 2026-08-10)
 *   - merge            performWineMerge ends in source.deleteOne() — the
 *                      absorbed record is destroyed, not tombstoned, so an
 *                      unmerge means rebuilding it by hand
 *   - non_wine         quarantines a row out of search and the queue
 *   - country          coarse, near-never blank on a real record, severe wrong
 *   - OVERWRITES       replacing a value someone already curated is a
 *                      different act from filling a blank
 *
 * THE NAME CHECK is the part that earns the loosened gate. The single proposal
 * the human gate caught that day was a wine named "Rosso Veronese" receiving
 * appellation "Veneto IGT" — a different denomination from the one its own name
 * states. That is mechanisable, and it generalises: if a wine's NAME contains a
 * curated appellation, a proposal naming a DIFFERENT one is a claim about the
 * label contradicting the record, which is exactly the judgement an admin
 * should keep.
 *
 * Crucially the check ROUTES, it does not REFUSE. Same day, the same rule fires
 * on "Prosecco" by Two Pairs → King Valley — and there the curator was RIGHT: a
 * King Valley Glera is a real category and stamping the Italian DOC on it would
 * have been the error. A rule that blocked the mismatch would have blocked the
 * most valuable correction of the day. So a mismatch means "an admin reads
 * this", never "this is wrong".
 *
 * Replayed over that day's 16: eleven apply themselves, and all three needing
 * judgement (Prosecco, Rosso Veronese, and the Monatio class — a name carrying
 * the generic designation "Vino Rosso", whose whole legal meaning is the
 * ABSENCE of a geographic indication) route to review.
 */
const Appellation = require('../models/Appellation');
const { normalizeAppellationKey } = require('../utils/normalize');

// Blank-fillable, reversible, and not part of the dedup key.
const DIRECT_FIELDS = ['appellation', 'region', 'classification'];

// A name is at most this many tokens deep for candidate generation — guards a
// pathological title from generating a quadratic number of lookups.
const MAX_NAME_TOKENS = 12;

/** True when the wine currently carries no value for this identity field. */
function fieldIsEmpty(wine, field) {
  const v = field === 'region' ? wine.region : wine[field];
  if (v === undefined || v === null) return true;
  // region is a ref; a populated doc or an ObjectId both count as SET.
  if (field === 'region') return false;
  return String(v).trim() === '';
}

/** An id from either a populated ref or a raw ObjectId, as a string. */
function idOf(v) {
  if (!v) return null;
  return String(v._id || v);
}

/**
 * The curated appellation a wine's NAME states, if any — longest match wins so
 * "Chianti Classico" beats "Chianti" and the check compares like with like.
 * Returns the Appellation doc, or null when the name claims no place.
 *
 * COUNTRY-SCOPED (2026-08-21). Without this, a name-derived appellation from
 * the wrong country reads as a place claim. Found live while dry-running a
 * backfill: Nockie's "Palette Pinot Noir" is a NEW ZEALAND wine and "Palette
 * Rose" a SOUTH AFRICAN one, and Palette is an AOC in Provence. Same producer,
 * two hemispheres, one French name — "Palette" there is a range name, not a
 * place, and the backfill would have written Provence onto both.
 *
 * The cost of missing it was not hypothetical in the other direction either:
 * a curator correcting that Pinot Noir to Marlborough would have been routed
 * for review because the name "disagreed", making them wait on a correction
 * that should apply instantly.
 *
 * A wine with no country cannot be checked, so the match stands — that is the
 * conservative reading (route rather than auto-apply), matching the old
 * behaviour exactly.
 */
async function appellationImpliedByName(name, countryId) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, MAX_NAME_TOKENS);
  if (!tokens.length) return null;

  // Every contiguous run of tokens, normalized the same way the resolver keys
  // its docs. One query for all of them rather than a lookup per candidate.
  const byKey = new Map();
  for (let start = 0; start < tokens.length; start++) {
    for (let end = start + 1; end <= tokens.length; end++) {
      const phrase = tokens.slice(start, end).join(' ');
      const key = normalizeAppellationKey(phrase);
      if (!key) continue;
      // Keep the longest phrase that produced each key.
      const prev = byKey.get(key);
      if (!prev || phrase.length > prev.length) byKey.set(key, phrase);
    }
  }
  if (!byKey.size) return null;

  const keys = [...byKey.keys()];
  let docs = await Appellation.find({
    $or: [{ normalizedName: { $in: keys } }, { normalizedSynonyms: { $in: keys } }],
  }).lean();
  if (!docs.length) return null;

  // Same appellation NAME can exist per country as separate docs (the model's
  // unique index is on country+normalizedName), so filtering here also picks
  // the RIGHT doc rather than an arbitrary one.
  const want = idOf(countryId);
  if (want) {
    docs = docs.filter((d) => idOf(d.country) === want);
    if (!docs.length) return null;
  }

  // Longest matched PHRASE wins, measured on the doc's own canonical name so a
  // short synonym cannot outrank the full appellation it stands for.
  let best = null;
  let bestLen = -1;
  for (const doc of docs) {
    const matchedKeys = [doc.normalizedName, ...(doc.normalizedSynonyms || [])].filter((k) => byKey.has(k));
    for (const k of matchedKeys) {
      const len = byKey.get(k).length;
      if (len > bestLen) { bestLen = len; best = doc; }
    }
  }
  return best;
}

/**
 * Do a name-stated appellation and a proposed one agree? Equality on the
 * normalized key, or one containing the other ("Côtes de Saint-Mont" in the
 * name, "Saint-Mont" proposed — the post-2011 rename, not a contradiction).
 */
function appellationsAgree(nameDoc, proposed) {
  const proposedKey = normalizeAppellationKey(proposed);
  if (!proposedKey) return false;
  const nameKeys = [nameDoc.normalizedName, ...(nameDoc.normalizedSynonyms || [])].filter(Boolean);
  return nameKeys.some((k) => k === proposedKey || k.includes(proposedKey) || proposedKey.includes(k));
}

/**
 * Is the PROPOSED appellation a curated one belonging to a different country
 * than the wine? Returns the conflicting doc, or null.
 *
 * This is the other half of the country rule, and the more important half.
 * Scoping the NAME check by country makes an Australian "Prosecco" stop
 * implying the Italian DOC — which is right, but on its own it would then let
 * a proposal WRITE "Prosecco" onto that Australian wine unchallenged. That is
 * precisely the error the curator warned about: Italy renamed the grape Glera
 * in 2009 and registered Prosecco as an EU GI, so the Italian DOC is exactly
 * what a careless rule stamps onto a King Valley wine while every field still
 * looks plausible.
 *
 * Free-text appellations that match no curated doc are NOT flagged: they carry
 * no country to disagree with, and appellations are deliberately open-ended
 * (see services/appellationResolve). Silence there is honest, not a gap.
 */
async function proposedAppellationCountryConflict(proposed, countryId) {
  const want = idOf(countryId);
  if (!want) return null;
  const key = normalizeAppellationKey(proposed);
  if (!key) return null;
  const docs = await Appellation.find({
    $or: [{ normalizedName: key }, { normalizedSynonyms: key }],
  }).lean();
  if (!docs.length) return null;
  // Curated somewhere, but nowhere in this wine's country.
  if (docs.some((d) => idOf(d.country) === want)) return null;
  return docs[0];
}

/**
 * May this proposal apply itself?
 *
 * @returns {Promise<{direct: boolean, reason: string}>} reason is written for
 *   the curator: when direct is false it says what to expect, not what failed.
 */
async function classifyProposal(wine, kind, proposedFields) {
  if (kind !== 'field_correction') {
    return { direct: false, reason: `${kind} proposals are always reviewed by an admin.` };
  }
  const fields = Object.keys(proposedFields || {});
  if (!fields.length) return { direct: false, reason: 'No fields proposed.' };

  const gated = fields.filter((f) => !DIRECT_FIELDS.includes(f));
  if (gated.length) {
    return {
      direct: false,
      reason: `${gated.join(', ')} ${gated.length > 1 ? 'are' : 'is'} admin-reviewed — only ${DIRECT_FIELDS.join(', ')} apply on filing.`,
    };
  }

  const occupied = fields.filter((f) => !fieldIsEmpty(wine, f));
  if (occupied.length) {
    return {
      direct: false,
      reason: `${occupied.join(', ')} already ${occupied.length > 1 ? 'have' : 'has'} a value — replacing curated data is admin-reviewed. Filling a blank is not.`,
    };
  }

  if (proposedFields.appellation) {
    const countryId = wine.country;

    // Checked BEFORE the name rule: a cross-border appellation is a claim
    // about the wine's own country, which outranks anything its name says.
    const foreign = await proposedAppellationCountryConflict(proposedFields.appellation, countryId);
    if (foreign) {
      return {
        direct: false,
        reason: `"${proposedFields.appellation}" is a curated appellation, but not in this wine's country — an admin reads that. If the wine really is from there, the country is what needs correcting first.`,
      };
    }

    const implied = await appellationImpliedByName(wine.name, countryId);
    if (implied && !appellationsAgree(implied, proposedFields.appellation)) {
      return {
        direct: false,
        reason: `The wine's name states "${implied.name}" but the proposal says "${proposedFields.appellation}" — an admin reads that difference. This is not a rejection: a name and a label genuinely disagree sometimes.`,
      };
    }
  }

  return { direct: true, reason: 'Blank identity fields, reversible, consistent with the name.' };
}

module.exports = {
  classifyProposal,
  appellationImpliedByName,
  proposedAppellationCountryConflict,
  appellationsAgree,
  fieldIsEmpty,
  DIRECT_FIELDS,
};
