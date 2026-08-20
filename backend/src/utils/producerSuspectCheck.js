/**
 * Does the producer note CONTRADICT the producer_suspect flag it was written
 * alongside?
 *
 * WHY (somm ticket 6a85f961, 2026-08-19). producer_suspect means "this value
 * is not a winery — it is a brand, a range, a retailer, a style term". But the
 * generator kept setting it on records whose own note says the opposite:
 *
 *     "Cave de Sainte-Marie-La-Blanche is a cooperative cellar in Burgundy"
 *     "Château Jeandeman is a small Fronsac estate not well documented"
 *     "This small Champagne grower is not one I can verify in detail"
 *
 * Every one of those describes a real producer the model simply cannot place —
 * which is what producerUnknown is for (introduced 2026-08-17: real winery,
 * publish, no owner-visible caveat). Left as suspect they earn a permanent
 * "cannot be verified" disclaimer on a real small estate's wine, and they
 * inflate upheld-count, the number the scaling review reads as "wines the
 * registry genuinely cannot identify".
 *
 * Prompt rules have twice failed to stop a class like this (type defaults,
 * speculative grapes). This is deterministic and reads only stored text.
 *
 * THE DISCRIMINATION THAT MATTERS. A note mentioning "estate" is not enough —
 * the correct fires mention one too, by DENYING it:
 *
 *     "Grande Arche appears to be a brand or negociant label rather than an
 *      established Saint-Émilion chateau"        ← correctly suspect
 *     "Aldi is a supermarket retailer that sources this wine from a contract
 *      producer rather than owning an estate"    ← correctly suspect
 *
 * So the test is which KIND of noun the note reaches for FIRST, before any
 * "rather than" / "not a" clause — because that clause introduces what the
 * thing ISN'T. Text after it is evidence about the wrong entity.
 *
 * Three deliberate narrownesses, so this only ever downgrades what it is sure of:
 *   - the producer's own name is stripped first, so a value literally called
 *     "Domaine Duffour" cannot vote for itself;
 *   - 'négociant' and 'cellar' are in NEITHER class. Both sit on the boundary
 *     ("a cellar/négociant bottling name" is a brand; "a Loire producer/
 *     negociant" is a house), so neither may trigger a downgrade alone;
 *   - a note with no producer-class noun at all — the category-only "not a
 *     producer I can confidently place" shape — is left ALONE. That is the
 *     genuinely ambiguous population, and it stays for a human or a search.
 */

// The note asserts the entity IS a wine producer.
//
// Two alternations, because the nouns are not equally strong. "estate",
// "winery", "grower" name a producer wherever they appear. The bare word
// "producer" does not — these notes use it constantly to refer to the FIELD
// ("cannot place this producer", "the producer name is unfamiliar"), so it
// only counts inside an actual assertion: "a Loire Valley producer".
// DELIBERATELY CASE-SENSITIVE, lowercase only. A capitalised producer noun is
// part of a proper NAME, not a claim about the entity — "Davey Estate appears
// to be a label", "Domaine des Granges de Mirabel appears to be a Pays d'Oc
// label". Both are the flag working correctly, and matching the capital
// inverted them. "is a small Fronsac estate" is the claim, and it is lowercase.
const PRODUCER_CLASS = new RegExp(
  '\\b(?:estates?|winer(?:y|ies)|growers?|domaines?|weing(?:ut|üter)|bodegas?'
  + '|quintas?|aziendas?|co[-\\s]?operatives?|co[-\\s]?ops?|vignerons?'
  + '|houses?|châteaux|chateaux)\\b'
  + '|\\ban?\\s+(?:[\\w\\u00C0-\\u024F\'’-]+\\s+){0,3}producers?\\b'
);

// "a house or cuvee name", "a bottling name" — the noun describes a NAME,
// which is the brand reading however producer-ish the noun looks alone.
const NAME_PHRASE = /^.{0,24}\bnames?\b/i;

// The note asserts it is a COMMERCIAL NAME rather than a producer.
const BRAND_CLASS = /\b(brands?|labels?|ranges?|retailers?|supermarkets?|bottlers?|bottling|importers?|merchants?|lines?|own[-\s]?label|private[-\s]?label|marketing|cuvée name|cuvee name|trade name|generic)\b/i;

// Everything after one of these describes what the entity is NOT. Both shapes
// occur in prod: the contrastive ("a brand rather than an estate") and the
// failed-verification ("could not be verified as an established winery") —
// the second one names a producer noun while DENYING it, so it has to cut too.
const CONTRAST = /\b(rather than|instead of|not an? |but not |could not be|cannot be|can not be|can't be|unable to|never been|does not|do not|did not|no longer)/i;

// Notes saying the producer FIELD holds a place or an appellation, not a house.
// These are the identity-blocking family (producer-is-appellation,
// producer-is-region) and they must never downgrade, however many producer
// nouns the sentence contains — both of the ones below were caught in the
// second prod dry run, matching "estate" inside a clause that denies one:
//
//   "The producer field simply repeats the appellation name, so no specific
//    estate can be identified"                                  (Monbazillac)
//   "Turckheim is also the name of an Alsace village and a well known
//    cooperative"                                               (Turckheim)
// The third alternation was added 2026-08-20 from the epistemic-rule dry run,
// which caught a note stating the value outright instead of by comparison:
//   "Chateau Etoile is not a producer I can verify; Château d'Etoile / L'Etoile
//    is an appellation in the Jura, so this may be a mislabeling"
// Epistemic in form, but it names what the field actually is, so it is a real
// suspicion. Requires "is a/an <place noun>" directly — "a producer in the
// Chablis appellation" is a producer claim and must not match.
// The lookbehind is load-bearing. Without it the alternation matches the
// METHODOLOGY these notes end with, whose subject is the profile rather than
// the producer, and a correct downgrade is blocked:
//   "Montlobre is not a producer I can confidently place; this profile IS AN
//    APPELLATION and style-level estimate."
const FIELD_IS_PLACE = /\b(repeats? the (appellation|region|village|commune)|is also the name of|simply repeats|no specific (estate|producer|winery|house)|(?<!\bprofile )is (?:also )?an? (?:appellation|village|commune|sub[-\s]?region|region|denomination|AOC|DOC|DOCG))\b/i;

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} note          aiProfile.producerNote as stored
 * @param {string} producerName  the wine's producer field, stripped so the
 *                               value cannot classify itself
 * @returns {boolean} true when the note describes a real producer and the
 *                    suspect flag should be a producerUnknown instead
 */
function noteAssertsProducer(note, producerName) {
  if (typeof note !== 'string' || !note.trim()) return false;
  // Checked on the RAW note, before any stripping: if the note says the field
  // holds a place or an appellation, no later producer noun can rescue it.
  if (FIELD_IS_PLACE.test(note)) return false;

  let text = note;
  const name = typeof producerName === 'string' ? producerName.trim() : '';
  if (name) text = text.replace(new RegExp(escapeRx(name), 'gi'), ' ');
  // "The producer name is unfamiliar…" refers to the FIELD, not to the entity
  // being a producer. Without this carve-out the generic word votes for a
  // downgrade in a sentence that is denying one.
  text = text.replace(/\bthe\s+producer(?:'s)?\s+name\b/gi, ' ');

  // Only the claim BEFORE the contrast clause is about this entity.
  const contrast = text.search(CONTRAST);
  if (contrast > -1) text = text.slice(0, contrast);

  const p = text.search(PRODUCER_CLASS);
  if (p === -1) return false;          // no positive producer claim → leave alone
  // "a house or cuvee name" — naming a name, not an entity.
  const matched = text.slice(p).match(PRODUCER_CLASS)?.[0] || '';
  if (NAME_PHRASE.test(text.slice(p + matched.length))) return false;
  const b = text.search(BRAND_CLASS);
  if (b === -1) return true;           // producer claim, nothing contradicting it
  return p < b;                        // whichever the note reached for first
}

// ── Sibling rule: the note asserts nothing at all ────────────────────────────

/**
 * A "rather than X" tail states what the thing is NOT, so brand vocabulary
 * inside it is not a claim that the field IS a brand. These notes end with a
 * methodology clause that constantly does this:
 *
 *   "…based on the grape and region rather than the specific bottling"
 *                                                          (Venica & Venica)
 *   "…based on the grapes and Heathcote region rather than a known house style"
 *
 * `bottling` is in BRAND_CLASS, so judging the raw string reads that as
 * evidence the field is a brand.
 *
 * Strip only the negated tail — NOT the whole methodology clause. A real claim
 * can follow one, and cutting at "so this profile is…" silently swallowed it:
 *
 *   "Palladium is not a producer I can confidently place for this wine; this
 *    profile is based on the McLaren Vale Shiraz style generally, likely a
 *    private-label or retailer brand."          ← caught in the first dry run
 *
 * That note is epistemic AND names what it probably is. The brand claim wins,
 * and it survives this narrower strip because nothing negates it.
 */
const NEGATED_TAIL = /\b(?:rather than|instead of)\b[^.;]*/gi;

// First-person knowledge vocabulary: the note is reporting the limits of what
// the MODEL knows, not a property of the entity.
const EPISTEMIC = new RegExp(
  '\\bI can(?:not|\'t)?\\b|\\bto me\\b|\\bknown to me\\b|\\bunfamiliar\\b'
  + '|\\bnot (?:widely |well )?documented\\b|\\bwell[-\\s]?documented\\b|\\bpoorly documented\\b'
  + '|\\bno (?:widely |publicly )?(?:available )?(?:public )?(?:information|records?|documentation)\\b'
  + '|\\bunable to (?:verify|identify|place|confirm)\\b',
  'i'
);

/**
 * The note claims the field is some OTHER kind of thing — a style, a grape, a
 * translation. That is a positive suspicion and producer_suspect is correct:
 *
 *   "Roșu Demidulce translates to Red Semi-Sweet in Romanian and is a wine
 *    style rather than a producer"                          (correctly suspect)
 */
const OTHER_CATEGORY = /\b(wine style|style rather|grape variet|translates? to|is a (?:designation|term|classification|category|blend)|generic (?:red|white|wine))\b/i;

/**
 * 'négociant' is deliberately in NEITHER of the two classes above, because it
 * sits on the boundary: "a cellar/négociant bottling name" is a brand, while
 * "a Loire producer/negociant" is a house. That ambiguity is fatal for
 * noteAssertsProducer, which needs it to vote one way.
 *
 * For THIS rule it is not ambiguous, because the question is different: the
 * test is whether the note makes any claim about the entity at all. "This may
 * be a négociant" is a claim, hedged or not — which is the precedence the
 * sommelier asked for ("B beating A is the knob"), with their own example:
 *
 *   "Jean XXII is not a producer I can confidently place; this may be a
 *    negociant or lesser-known bottling"     ← epistemic AND a claim → suspect
 */
const CLASSIFIES_AS_TRADE = /\b(n[ée]gociants?|negociants?|co[-\s]?packer|contract (?:producer|winery)|sourced (?:by|from)|used by multiple producers)\b/i;

/**
 * Does the note record only that the model could not place the name — with no
 * assertion about what the producer field actually is?
 *
 * WHY (somm ticket 6a86baca, 2026-08-20). `producer_suspect` asserts a positive
 * suspicion: this value is a brand, a range, a retailer, a place. An epistemic
 * note asserts no such thing — it says the model could not verify the name,
 * which is what `producerUnknown` means. Both flags describe our knowledge;
 * only one adds a claim the note never made.
 *
 * The somm's own counter-example settled it: La Spia carried a pure epistemic
 * note and turned out to be a real Valtellina winery, confirmed in the same
 * session it was sitting in the suspect queue. Left as suspect, a real estate
 * wears a permanent "cannot be verified" caveat on its wine.
 *
 * This is the population {@link noteAssertsProducer} deliberately declined to
 * touch on 2026-08-19 ("left ALONE… stays for a human or a search"). That call
 * was wrong for the reason above, and this is its reversal — narrowly, because
 * the guards below still refuse anything making a positive claim.
 *
 * @param {string} note          aiProfile.producerNote as stored
 * @param {string} producerName  the wine's producer field
 * @returns {boolean} true when the note is purely epistemic and the suspect
 *                    flag should be a producerUnknown instead
 */
function noteIsEpistemicOnly(note, producerName) {
  if (typeof note !== 'string' || !note.trim()) return false;
  // Raw note, before any cutting: a field-is-a-place note is a positive claim
  // however tentatively it is worded.
  if (FIELD_IS_PLACE.test(note)) return false;

  if (!EPISTEMIC.test(note)) return false;
  // Any positive claim about what the field IS instead → a real suspicion,
  // and producer_suspect is the right flag. Judged with the negated tails
  // removed, so "rather than the specific bottling" cannot vote.
  const positive = note.replace(NEGATED_TAIL, ' ');
  if (BRAND_CLASS.test(positive)) return false;
  if (OTHER_CATEGORY.test(positive)) return false;
  if (CLASSIFIES_AS_TRADE.test(positive)) return false;
  // A note that positively calls it a producer is the sibling rule's business,
  // so the two rules stay disjoint and their tags stay meaningful.
  if (noteAssertsProducer(note, producerName)) return false;
  return true;
}

/**
 * Rule identifiers stamped on `aiProfile.suspectDowngradedBy` when either rule
 * clears a flag, so the moved rows stay queryable as a set (somm request
 * 6a86baca — "residue should be a query, not a queue"). Never reused for
 * anything else, and never set by a human decision: a curator verdict goes to
 * suspectDecision, which is a judgement, not a rule application.
 */
const DOWNGRADE_RULES = {
  ASSERTS_PRODUCER: 'note_asserts_producer',
  EPISTEMIC_ONLY: 'note_epistemic_only',
};

module.exports = {
  noteAssertsProducer, noteIsEpistemicOnly, DOWNGRADE_RULES,
  PRODUCER_CLASS, BRAND_CLASS, CONTRAST,
  // Exported so the A/B split can be MEASURED separately from the combined
  // predicate — the sommelier asked for a four-way population breakdown
  // (6a86baca), and deriving it from the folded rule would only ever confirm
  // the rule's own shape.
  EPISTEMIC, OTHER_CATEGORY, CLASSIFIES_AS_TRADE, FIELD_IS_PLACE, NEGATED_TAIL,
};
