// Row mappers shared by the sommelier tools (mcp/tools/somm.js and, as the
// families move out, mcp/tools/somm/<family>.js): how a registry wine, its
// grapes, its identity provenance and its tasting profile read on a curator's
// queue row. Output shapes only; nothing here writes.

const aiConfig = require('../../../config/aiConfig');
const { labelSweetnessFields, sweetnessStyleFields } = require('../../toolUtil');
const { hasProfileContent } = require('../../../utils/profileReview');

/**
 * Which identity fields a MODEL supplied rather than a person.
 *
 * Emitted as a list of field names, and only when at least one qualifies —
 * the common case is a wine nobody needs warned about, and a key reading
 * `inferred_fields: []` on every row is noise a curator learns to skip.
 *
 * An import file that carries appellation but no grapes produces wines whose
 * grapes are inferred by the model FROM the appellation — every Montlouis
 * comes out Chenin Blanc, even a pétillant naturel that is mostly Menu
 * Pineau. Such values are wrong, mutually consistent and indistinguishable
 * from researched ones. This is the signal that tells them apart: not
 * "this is wrong", but "nobody asserted this".
 */
const provenanceLite = (provenance) => {
  if (!provenance) return {};
  // Mongoose Map on a hydrated doc, plain object on a .lean() one.
  const entries = typeof provenance.entries === 'function'
    ? [...provenance.entries()]
    : Object.entries(provenance);
  const inferred = entries.filter(([, source]) => source === 'model').map(([field]) => field).sort();
  return inferred.length ? { inferred_fields: inferred } : {};
};

/**
 * Grapes, emitted HONESTLY or not at all. Callers differ in what they select
 * and populate, and an unpopulated ref array must not collapse to
 * `grapes: []` — that is a claim of "no grapes" on a wine that has them. So:
 * populated docs → names; a genuinely empty array → []; unpopulated ids or
 * an unselected field → the key is omitted, meaning "not carried on this
 * surface".
 */
const grapesLite = (grapes) => {
  if (!Array.isArray(grapes)) return {};
  const names = grapes.map((g) => g?.name).filter(Boolean);
  if (grapes.length > 0 && names.length === 0) return {}; // ids, not docs
  return { grapes: names };
};

/**
 * A registry wine as a queue row carries it. The label sweetness term is
 * emitted honestly or not at all (services/sweetnessOps.labelSweetnessFields):
 * a loaded field → the term ({ name, band, scale, regulated } or null) and
 * the display name; an unselected field or an id nothing can name → neither
 * key. The curator setting a drink window reads it here — once the word has
 * left the names, this is where "trocken" is stated. Grapes show like every
 * other identity field; without them, grapes written at wine creation become
 * visible only on a later get_wine, and read as "populated by an unidentified
 * path during curation".
 */
const wineLite = (wd, { termLoaded = false, styleLoaded = false } = {}) => (wd ? {
  wine_id: wd._id,
  name: wd.name,
  producer: wd.producer || null,
  type: wd.type || null,
  country: wd.country?.name || null,
  region: wd.region?.name || null,
  appellation: wd.appellation || null,
  ...(labelSweetnessFields(wd, { loaded: termLoaded })),
  // The sweetness style beside it, when the read asked for it.
  ...(sweetnessStyleFields(wd, { loaded: styleLoaded })),
  ...(grapesLite(wd.grapes)),
  ...(provenanceLite(wd.identityProvenance)),
} : null);

/**
 * The tasting profile as a curator needs to judge it: the values, plus WHO
 * wrote them and how sure the generator was. `confidence` is the model's own
 * self-rating and is not a correctness score — a 0.6 profile inverted the
 * facts about a Vintage Port — so it is labelled, not thresholded.
 *
 * A HELD profile carries the doubt but no prose, which would make it look
 * exactly like a wine that was never enriched — the curator could not tell
 * whether a missing tasting note meant "not generated yet" or "generated and
 * withheld from the owner". So it reports itself (`withheld`). No profile at
 * all reports itself too (`absent`), with what will actually happen to it.
 *
 * producer_unknown rides along on every shape: it is the difference between
 * "this record is wrong" and "this is a small estate the model cannot place",
 * and a curator judging a drink window should know which they are looking at.
 *
 * @param {object} ap    aiProfile subdoc
 * @param {object} wine  the wine, for the absent-profile explanation
 */
const profileLite = (ap, wine) => {
  // NO PROFILE. Not a silent null meaning "the batch has not reached it
  // yet": under the enrichmentOnAdd policy it usually means automatic
  // enrichment DECLINED the record — permanently, for a record too thin to
  // say anything true — so the curator writing the drink window is the one
  // who will write the profile. A null could not say that.
  if (!hasProfileContent(ap)) {
    const { identityDataSufficient } = require('../../../services/enrichmentJob');
    // Degrade to the softer message rather than throwing: this runs inside a
    // row mapper, so a missing export would take out the whole queue listing
    // over a cosmetic label.
    const thin = wine && typeof identityDataSufficient === 'function'
      ? !identityDataSufficient({ ...wine, grapes: wine.grapes || [] })
      : false;
    // auto_enrich must describe what will ACTUALLY happen. A hard-coded
    // "pending" reads as "someone else will write this" — but with automatic
    // enrichment switched off, nothing is coming. A value that names a future
    // that will not arrive is worse than no value: it tells the curator to
    // wait.
    const mode = aiConfig.get().enrichmentOnAdd;
    let autoEnrich;
    let reason;
    if (thin) {
      autoEnrich = 'skipped_thin_identity';
      reason = 'no region or appellation on the record, so automatic enrichment skips it — this profile is yours to write';
    } else if (mode === 'off') {
      autoEnrich = 'off';
      reason = 'automatic enrichment is switched off, so nothing will write this — the profile is yours to write';
    } else {
      autoEnrich = 'pending';
      reason = 'not enriched yet';
    }
    return { absent: true, reason, auto_enrich: autoEnrich };
  }
  if (ap.heldAt) {
    return {
      withheld: true,
      withheld_reason: ap.producerNote
        || (ap.heldReason === 'low_confidence' || ap.heldReason === 'unknown_low_confidence'
          ? 'generated below the publication confidence floor; awaiting review'
          : 'the producer field does not look like a real winery; awaiting review'),
      // Machine-readable WHY: 'producer_suspect' | 'low_confidence' |
      // 'unknown_low_confidence' | 'producer_claim' | … ; null on rows held
      // before the field existed.
      held_reason: ap.heldReason || null,
      producer_suspect: ap.producerSuspect === true,
      producer_unknown: ap.producerUnknown === true,
      ai_confidence: ap.confidence ?? null,
      description: null,
      source: ap.source || 'ai',
      // A search-assisted retry ALSO failed the gate — this row's doubt
      // survived a web search, so releasing it needs real curator facts, not
      // another plain regeneration.
      ...(ap.searchUsed === true ? { search_assisted: true } : {}),
    };
  }
  if (!(ap.description || ap.body)) return null;
  return {
    body: ap.body || null,
    tannin: ap.tannin || null,
    acidity: ap.acidity || null,
    sweetness: ap.sweetness || null,
    flavors: ap.flavors || [],
    food_pairings: ap.foodPairings || [],
    description: ap.description || null,
    source: ap.source || 'ai',
    ai_confidence: ap.source === 'curator' ? null : (ap.confidence ?? null),
    // Present on AI profiles so the curator can weigh the prose: an
    // unplaceable producer means the note is appellation-level typicity, not
    // knowledge of this house.
    producer_suspect: ap.producerSuspect === true,
    producer_unknown: ap.producerUnknown === true,
    producer_note: ap.producerNote || null,
    verified_at: ap.verifiedAt || null,
    // This profile came from the web-search rescue retry. Flagged so quality
    // judgements on searched rows can be tallied apart. Omitted when false to
    // keep payloads lean.
    ...(ap.searchUsed === true ? { search_assisted: true } : {}),
  };
};

module.exports = { wineLite, grapesLite, provenanceLite, profileLite };
