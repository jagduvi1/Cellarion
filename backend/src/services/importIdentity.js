// Import identity: what an import row says a wine is.
//
// A row that matches no registry wine proposes one. Its identity comes from
// two sources, the user's file and the AI's reading of it, and the file wins
// wherever it speaks (buildProposedWine); the audit keeps which source
// supplied each field (computeIdentityProvenance). A row whose file already
// states the whole identity skips the AI altogether (fileCompleteIdentity).
//
// Callers: POST /api/bottles/import/validate and /confirm in routes/import.js,
// which re-exports the three functions for their tests.
//
// This module stays free of Express and of the database: the grape taxonomy is
// passed in as a lookup (`grapeColourOf`).

const { normalizeString, resolveCountryName, isRecognizedCountry, isUnknownName, isIdentitySentinel } = require('../utils/normalize');
const { pradikatOnlyValue, pradikatContradictsName } = require('../utils/styleTerms');
const { sanitizeGrapeNames } = require('../utils/sanitize');
const { WINE_TYPES } = require('./wineProfileOps');

// Below this identification confidence the AI is going on inference, not
// knowledge ("0.5 = reasonably sure" in the prompt's own scale) — exactly the
// band that writes a producer's home region onto wines from elsewhere and splits
// one producer across region granularities. Geography the
// AI proposed under this floor is dropped before it can mint; the curation
// backfill queue fills it from evidence instead.
//
// ⚠️ THIS FLOOR APPLIES TO AI-DERIVED GEOGRAPHY ONLY. It used to be justified
// by "import files carry no region/appellation columns, so this only ever
// strips AI inference — never user data", and that stopped being true:
// importMappers maps CellarTracker's Appellation, its
// Country/Region/SubRegion/Appellation Locale path, SubRegion and a generic
// appellation column, and findExactRegistryWine/scoreCandidate below have been
// matching on item.appellation all along. So the floor WAS deleting what the
// user typed. Measured 2026-08-21: one 231-wine import produced 86 null/null
// registry rows, and over half of a curation day went on putting back
// appellations the file had supplied. File geography now wins outright and is
// never subject to this floor — see buildProposedWine.
const AI_GEOGRAPHY_MIN_CONFIDENCE = 0.6;

/**
 * The wine a no-match row proposes to mint, built from the AI identification
 * and the user's own file row.
 *
 * PRECEDENCE: file geography beats AI geography, always. The file is what the
 * label says as the owner read it; the AI is recalling. The confidence floor
 * exists to stop the model ASSERTING a place it inferred, and it has no
 * business deleting a column the user filled in.
 *
 * Kept as a named function (rather than inline in the /validate loop) so the
 * precedence is unit-testable — it is the rule that decides what enters the
 * shared registry, and it was previously an expression buried 500 lines in.
 */
function buildProposedWine(aiData, item) {
  const clean = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || null;
  };
  // Below the floor the model is inferring, not knowing (part B below).
  const lowGeoConfidence =
    !(typeof aiData.confidence === 'number' && aiData.confidence >= AI_GEOGRAPHY_MIN_CONFIDENCE);
  const fromAi = (v) => (lowGeoConfidence ? null : clean(v));

  // A purely-Prädikat appellation is routed out of the field entirely; only a
  // Prädikat the wine itself does not contradict is rescued into the
  // classification. See pradikatContradictsName: a row can put
  // Trockenbeerenauslese on a wine named "Riesling Trocken", and rescuing that
  // would keep the falsehood and merely move which field carries it.
  const filePradikat = pradikatOnlyValue(clean(item && item.appellation));
  const rescuedPradikat = filePradikat && !pradikatContradictsName(filePradikat, aiData.name)
    ? filePradikat
    : null;

  return {
    name: aiData.name,
    // A file with no producer column gets its producer from the model, and
    // the model — told a name-equals-producer estate wine is fine — sometimes
    // mirrors an unknown cuvée name back as the producer (name and producer
    // both "Les Caractères"). That is a
    // missing producer, not a producer: leave it empty so the row mints as a
    // pending identity for a curator, unless the name itself is an estate.
    producer: producerMirroredFromName(aiData, item) ? null : aiData.producer,
    // Country keeps the AI's value first: it is fed the file's country as a
    // hint and normalizes local-language names ("Deutschland" → "Germany"),
    // which the raw column does not. The file is the fallback, which is new —
    // a countryless identification used to cost the user the row entirely.
    country: clean(aiData.country) || clean(item && item.country),
    region: clean(item && item.region) || fromAi(aiData.region),
    // A file's appellation column sometimes holds the ripeness Prädikat rather
    // than a place — "Auslese" for a Mosel Riesling, say. Taken literally the
    // wine ends up with
    // NO appellation, which is the thin-identity condition that makes
    // auto-enrichment decline it for good: the owner's data-entry habit
    // silently costs them their tasting notes. So a purely-Prädikat value is not
    // treated as geography, and the model's place name fills the field instead.
    // pradikatOnlyValue refuses anything that might also name a place.
    appellation: filePradikat
      ? fromAi(aiData.appellation)
      : (clean(item && item.appellation) || fromAi(aiData.appellation)),
    // Same floor as geography: a classification is an assertion of knowledge
    // (the identify prompt asks for it), and the file's
    // own value outranks it for the same reason.
    //
    // A Prädikat rescued from the appellation column lands HERE, where it was
    // always meant to go, and outranks the model for the same reason any other
    // file value does — the owner read it off the bottle. Only when the file
    // states no classification of its own.
    classification: clean(item && item.classification)
      || rescuedPradikat
      || fromAi(aiData.classification),
    // Same precedence as the geography above: the file states what the label
    // says, the model recalls. Only ever a value the schema accepts — a
    // client can send anything, and an invalid colour must fall through to
    // the AI rather than fail the mint. The parsers now emit null for an
    // unknown colour instead of guessing 'red', so a null here is an honest
    // "the file did not say", not a lost value.
    type: (WINE_TYPES.includes(clean(item && item.type)) ? clean(item.type) : null) || aiData.type,
    grapes: aiData.grapes,
    confidence: aiData.confidence,
  };
}

/**
 * Which source supplied each identity field of an AI-identified import row.
 *
 * Computed SERVER-SIDE at mint from the file row, deliberately not carried on
 * the aiWine object the client round-trips: provenance is a claim about our
 * own pipeline, and a claim a client could edit is worth nothing.
 *
 * The rules mirror mergeAiWithFile's precedence exactly — file first for the
 * label-stated fields, model for the rest. Its curator-facing point: a grape
 * the model INFERRED FROM THE APPELLATION must not look identical to one the
 * owner's file stated. A file with appellations and no grapes can get each
 * wine its appellation's signature grape from the model, which an off-type
 * cuvée does not have.
 *
 * @param {Object} item the file's row
 * @param {Object} ai the identified wine actually being minted
 * @returns {Object<string,'file'|'model'>}
 */
function computeIdentityProvenance(item, ai) {
  const stated = (v) => typeof v === 'string' && v.trim() !== '';
  const fileType = stated(item?.type) && WINE_TYPES.includes(String(item.type).trim().toLowerCase());
  // The one field with a genuine file fallback on this path: /validate
  // supplements the AI's empty grape list from the row (see the importGrapes
  // branch), so a grape list CAN be the file's.
  const fileGrapes = sanitizeGrapeNames(item?.grapes);
  const aiGrapes = Array.isArray(ai?.grapes) ? ai.grapes : [];
  const grapesFromFile = fileGrapes.length > 0 && aiGrapes.length > 0
    && aiGrapes.every((g) => fileGrapes.some((f) => normalizeString(f) === normalizeString(g)));
  const filePrad = pradikatOnlyValue(stated(item?.appellation) ? item.appellation.trim() : '');
  const rescuedPrad = filePrad && !pradikatContradictsName(filePrad, ai?.name) ? filePrad : null;

  return {
    name: 'model',
    producer: 'model',
    country: stated(item?.country) && !stated(ai?.country) ? 'file' : 'model',
    region: stated(item?.region) ? 'file' : 'model',
    // Follows the VALUE, not the column it was typed in: a rescued Prädikat
    // leaves the appellation to the model and supplies the classification
    // itself, and provenance is what the sommelier reasons from.
    appellation: stated(item?.appellation) && !filePrad ? 'file' : 'model',
    classification: stated(item?.classification) || rescuedPrad ? 'file' : 'model',
    type: fileType ? 'file' : 'model',
    grapes: grapesFromFile ? 'file' : 'model',
  };
}

// Vivino-shaped cellar exports name the varietal composition rather than the
// grape: "Sangiovese Blend", "Red Blend", "Sémillon-Sauvignon Blanc Blend".
// None of those are taxonomy grape names, so a plain lookup misses every one
// — which silently disabled the complete-row bypass for an entire export
// format (measured on a real 186-row import: 60 wines fell through to
// requests, 10 AI calls spent, the bypass never fired once).
//
// Two readings, both conservative, both anchored on the trailing "Blend":
//
//   "Red Blend" / "White Blend" / "Rosé Blend" / "Red Bordeaux Blend"
//       — the file states the COLOUR itself. Better evidence than any
//         inference: take it directly. Requiring the trailing "blend" is what
//         keeps a grape merely STARTING with a colour word (the table grape
//         "Red Globe") out of this branch.
//
//   "Sangiovese Blend" / "Tempranillo Blend" / "Trebbiano Blend"
//       — a lead varietal plus a suffix. Strip the suffix and ask the
//         taxonomy about the remainder.
//
// Everything else ("Port Blend", "SuperTuscan Blend", "Cabernet-Shiraz
// Blend") resolves to nothing and falls through to the AI, which is the
// right outcome: a composition this module cannot read is exactly what the
// model is for.
// NB the explicit `\s+` rather than a `\b` after the colour: "é" is not a
// word character in JS regex, so `ros[ée]\b` never matches "Rosé Blend" —
// the one case a boundary assertion silently drops.
const COLOUR_BLEND = /^(red|white|ros[ée])\s+(.*\s+)?blends?$/i;
const BLEND_SUFFIX = /\s+blends?$/i;

function typeFromFileGrapes(grapes, grapeColourOf) {
  for (const g of grapes) {
    const m = COLOUR_BLEND.exec(String(g).trim());
    if (m) {
      const c = m[1].toLowerCase();
      return c === 'red' ? 'red' : (c === 'white' ? 'white' : 'rosé');
    }
  }
  if (typeof grapeColourOf !== 'function') return null;
  const colours = new Set();
  for (const g of grapes) {
    const raw = String(g).trim();
    const colour = grapeColourOf(raw) || grapeColourOf(raw.replace(BLEND_SUFFIX, ''));
    if (colour) colours.add(colour);
  }
  if (colours.size !== 1) return null;              // silent or contradictory → AI
  return colours.has('Red') ? 'red' : 'white';
}

// Estate names legitimately double as the wine name ("Château Talbot",
// "Harlan Estate", "Schloss Johannisberg") — the estate word may lead or
// trail (audit 2026-09-07).
const ESTATE_WORD_RE = /\b(ch[âa]teau|domaine|clos|quinta|tenuta|castello|weingut|bodegas?|mas|cascina|fattoria|azienda|cantina|villa|podere|poderi|finca|casa|ch\.|estate|winery|vineyards?|cellars?|schloss|maison|weinbau|abbazia|marchesi|vignobles|adega|herdade)\b/i;
function producerMirroredFromName(aiData, item) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  // A sentinel producer ("Unknown", "-") is "the file gave none" too.
  const fileProducer = str(item && item.producer);
  if (fileProducer && !isIdentitySentinel(fileProducer)) return false; // the file said it — keep it
  const name = str(aiData && aiData.name);
  const producer = str(aiData && aiData.producer);
  if (!name || !producer) return false;
  if (normalizeString(name) !== normalizeString(producer)) return false;
  return !ESTATE_WORD_RE.test(name);
}

/**
 * Complete-row AI bypass (the somm is free and we pay for AI). A row whose
 * FILE already states the identity does not need a
 * model to restate it: findOrCreateWine's ladder does the normalization work
 * deterministically (producer-prefix canon, trailing-vintage strip,
 * estate-name unpollution, appellation resolution), the somm/enrichment
 * pipeline fills the tail, and the AI call would mostly echo the row back.
 * One large import measured 430 debited calls; most rows carried full data.
 * The AI keeps the rows it is actually FOR: incomplete or messy ones.
 *
 * The gate is "can this row mint cleanly and match correctly without AI",
 * NOT "is every column filled":
 *   - producer + wineName + country: required. Identity plus the one field
 *     the mint hard-requires — and the country must RESOLVE (the file may
 *     say "AU"; resolveCountryName normalizes it, and an unrecognizable
 *     country would only turn into a /confirm-time error).
 *   - type: the file's, or inferred from the file's grapes when they all
 *     share one taxonomy colour (Riesling → white). Without either the row
 *     goes to AI — findOrCreateWine defaults a missing type to 'red', and a
 *     white minted red is exactly the silent error the AI's answer prevents.
 *     (Known limit: a red-grape rosé with no type column infers 'red' — the
 *     file's own type column always wins when present.)
 *   - grapes, region, appellation: NEVER gate the bypass. Grapes are
 *     inferable from the name and enrichable later; region derives from the
 *     appellation (regionForAppellation — the appellation's region
 *     deliberately outranks the file's); appellation was never required.
 *
 * Returns an aiIdentified-shaped object (confidence null) so Pass 2 and the
 * result builder treat the row exactly like an AI-identified one — same
 * matchOnly probe, same buildProposedWine precedence, no third path — or
 * null when the row genuinely needs (or lacks the data to skip) the model.
 */
function fileCompleteIdentity(item, grapeColourOf) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const name = clean(item.wineName);
  const producer = clean(item.producer);
  if (!name || !producer) return null;
  if (isUnknownName(name) || isUnknownName(producer)) return null;

  const country = resolveCountryName(clean(item.country) || '');
  if (!country || !isRecognizedCountry(country)) return null;

  const grapes = sanitizeGrapeNames(item.grapes);

  let type = clean(item.type);
  if (!WINE_TYPES.includes(type)) type = null;
  if (!type && grapes.length > 0) type = typeFromFileGrapes(grapes, grapeColourOf);
  if (!type) return null;

  // Same Prädikat routing as the AI path — this path
  // has no model to supply the place, so the appellation is simply left empty
  // rather than filled with a ripeness level. Empty is the honest state and
  // costs nothing here: enrichment's identityDataSufficient needs a place
  // axis, and the region satisfies it. Storing the Prädikat instead would
  // cost something real, because generateWineKey and the match scorer both
  // read the appellation — the same wine arriving from another owner's file
  // with a proper appellation would key differently and mint a duplicate.
  const filePradikat = pradikatOnlyValue(clean(item.appellation));
  const rescuedPradikat = filePradikat && !pradikatContradictsName(filePradikat, name)
    ? filePradikat
    : null;

  return {
    name,
    producer,
    country,
    region: clean(item.region),
    appellation: filePradikat ? null : clean(item.appellation),
    classification: clean(item.classification) || rescuedPradikat,
    type,
    grapes,
    confidence: null,
  };
}

module.exports = {
  AI_GEOGRAPHY_MIN_CONFIDENCE,
  buildProposedWine,
  computeIdentityProvenance,
  fileCompleteIdentity,
};
