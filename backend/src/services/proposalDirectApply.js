/**
 * Which curator corrections may apply themselves, and which still need an
 * admin.
 *
 * WHY. Most identity corrections are lookups ("Barolo by Cà di Bruno is in
 * Piedmont"). Sending each past an admin spends the scarcest resource in the
 * loop — the admin's attention — and, worse, serialises the curator behind a
 * review round trip while new wines keep arriving. The gate is not wrong; it
 * is priced wrong for filling a blank.
 *
 * THE LINE IS REVERSIBILITY, NOT TRUST. A proposal applies itself only when it
 * FILLS A BLANK on a field that can be edited back:
 *
 *   appellation / region / classification, each currently empty
 *
 * Everything else keeps the admin gate, for reasons that are specific rather
 * than cautious:
 *   - producer / name  drive normalizedKey and the public URL, and are the
 *                      class where a curator's assertion is most often
 *                      overturned by web verification
 *   - merge            performWineMerge ends in source.deleteOne() — the
 *                      absorbed record is destroyed, not tombstoned, so an
 *                      unmerge means rebuilding it by hand
 *   - country          coarse, near-never blank on a real record, severe wrong
 *   - OVERWRITES       replacing a value someone already curated is a
 *                      different act from filling a blank
 *
 * THE NAME CHECK is the part that earns the loosened gate. A wine named
 * "Rosso Veronese" receiving appellation "Veneto IGT" gets a different
 * denomination from the one its own name states. That is mechanisable, and it
 * generalises: if a wine's NAME contains a curated appellation, a proposal
 * naming a DIFFERENT one is a claim about the label contradicting the record,
 * which is exactly the judgement an admin should keep.
 *
 * Crucially the check ROUTES, it does not REFUSE. The same rule fires on
 * "Prosecco" by Two Pairs → King Valley — and there the curator is RIGHT: a
 * King Valley Glera is a real category and stamping the Italian DOC on it
 * would be the error. A rule that blocked the mismatch would block exactly
 * such a correction. So a mismatch means "an admin reads this", never "this
 * is wrong".
 *
 * NON-WINE applies on filing too, by the same reversibility line. The
 * quarantine is a flag: the row leaves registry search and the maturity
 * queue, every owner's bottles keep working, and an admin restores it in one
 * click (Admin → Wines → Proposals → Decided), which re-seeds the queue rows
 * the quarantine removed. Behind the gate, beers and ciders would sit in
 * public search for hours after the curator named them, waiting on an admin
 * to agree with the obvious. One exception keeps the gate — a row several
 * members hold. A beer is rarely in four cellars; a real wine with an odd
 * name often is, and hiding it from all of them is an admin's call.
 *
 * THE SWEETNESS STYLE applies on filing as well, by the same line, and it is
 * the one field a MEMBER's own filing applies on a server that reviews
 * (memberAppliesOnFiling). It is the term a wine is known by when its label
 * prints none: never part of the dedup key, the slug or the display name,
 * never written without the page that names it, and cleared with one edit.
 * What decides is the write rule itself (services/sweetnessWrite
 * assignSweetnessStyle), asked without writing: only a style the rule would
 * WRITE AS FILED on a wine that has none applies. A style the label's own
 * term contradicts, a second opinion on a recorded style, a term with a legal
 * definition named by the trade — the rule holds or refuses those, and they
 * go to a person.
 */
const Appellation = require('../models/Appellation');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { normalizeAppellationKey } = require('../utils/normalize');
const { STYLE_FIELD, probeSweetnessStyle } = require('./proposalFields');

// Blank-fillable, reversible, and not part of the dedup key.
const DIRECT_FIELDS = ['appellation', 'region', 'classification', STYLE_FIELD];

// A non-wine flag applies on filing while at most this many members hold a
// bottle of the row (any status — a drunk bottle is still in their history).
// A member = the owner or a member of a cellar with a bottle of it: a
// bottle's `user` is the cellar OWNER, so counting that would make ten
// members of one shared cellar count as one.
const NON_WINE_DIRECT_MAX_OWNERS = 3;

async function countHoldingMembers(wineId) {
  const cellarIds = await Bottle.distinct('cellar', { wineDefinition: wineId });
  if (!cellarIds.length) return 0;
  const cellars = await Cellar.find({ _id: { $in: cellarIds }, deletedAt: null }).select('user members.user').lean();
  const people = new Set();
  for (const c of cellars) {
    if (c.user) people.add(String(c.user));
    for (const m of c.members || []) if (m.user) people.add(String(m.user));
  }
  return people.size;
}

// A name is at most this many tokens deep for candidate generation — guards a
// pathological title from generating a quadratic number of lookups.
const MAX_NAME_TOKENS = 12;

/** True when the wine currently carries no value for this identity field. */
function fieldIsEmpty(wine, field) {
  // A style is an object, set or not: the wine must be loaded with it.
  if (field === STYLE_FIELD) return wine.sweetnessStyle == null;
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
 * COUNTRY-SCOPED. Without this, a name-derived appellation from the wrong
 * country reads as a place claim: Nockie's "Palette Pinot Noir" is a NEW
 * ZEALAND wine and "Palette Rose" a SOUTH AFRICAN one, and Palette is an AOC
 * in Provence. Same producer, two hemispheres, one French name — "Palette"
 * there is a range name, not a place, and a backfill would write Provence
 * onto both.
 *
 * It costs in the other direction too: a curator correcting that Pinot Noir
 * to Marlborough would be routed for review because the name "disagreed",
 * waiting on a correction that should apply instantly.
 *
 * A wine with no country cannot be checked, so the match stands — that is the
 * conservative reading (route rather than auto-apply).
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
  if (kind === 'non_wine') {
    const owners = await countHoldingMembers(wine._id);
    if (owners > NON_WINE_DIRECT_MAX_OWNERS) {
      return {
        direct: false,
        reason: `${owners} members hold bottles of this wine — hiding it from all of them is an admin's call.`,
      };
    }
    return { direct: true, reason: 'A reversible flag on a row few members hold.' };
  }
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

  if (proposedFields[STYLE_FIELD]) {
    const style = await styleWritesAsFiled(wine, proposedFields);
    if (!style.direct) return style;
  }

  return { direct: true, reason: 'Blank identity fields, reversible, consistent with the name.' };
}

/**
 * Would the write rule write this proposed sweetness style exactly as filed?
 * Asked without writing (services/proposalFields probeSweetnessStyle); `wine`
 * must be loaded with sweetnessStyle. Anything the rule holds, refuses or
 * leaves to a person is not direct.
 */
async function styleWritesAsFiled(wine, proposedFields) {
  const probe = await probeSweetnessStyle(wine, proposedFields);
  if (probe.ok && probe.verdict === 'applied') {
    return { direct: true, reason: 'A sourced sweetness style on a wine that has none: reversible, and no part of its identity.' };
  }
  return {
    direct: false,
    reason: probe.message
      || 'The wine already carries a sweetness term this style has to be weighed against — an admin reads that.',
  };
}

/**
 * May a MEMBER's field correction apply on filing, on a server that reviews
 * contributions? One case: the pending suggestion holds a sweetness style and
 * nothing else, the wine has no style recorded, and the write rule would
 * write it as filed. Every other member correction waits for a curator.
 * `proposedFields` is the WHOLE pending row (an amendment included), `wine`
 * loaded with sweetnessStyle. Returns { direct, reason } like classifyProposal.
 * Caller: createFieldCorrection (services/wineProposalOps).
 */
async function memberAppliesOnFiling(wine, proposedFields) {
  const fields = Object.entries(proposedFields || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k]) => k);
  if (fields.length !== 1 || fields[0] !== STYLE_FIELD) {
    return { direct: false, reason: 'Only a sweetness style on its own applies on filing.' };
  }
  if (!fieldIsEmpty(wine, STYLE_FIELD)) {
    return { direct: false, reason: 'The wine already has a sweetness style — replacing it is reviewed.' };
  }
  return styleWritesAsFiled(wine, proposedFields);
}

module.exports = {
  classifyProposal,
  memberAppliesOnFiling,
  appellationImpliedByName,
  proposedAppellationCountryConflict,
  appellationsAgree,
  NON_WINE_DIRECT_MAX_OWNERS,
  countHoldingMembers,
};
