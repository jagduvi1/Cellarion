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
const PRODUCER_CLASS = new RegExp(
  '\\b(?:estates?|winer(?:y|ies)|growers?|domaines?|weing(?:ut|üter)|bodegas?'
  + '|quintas?|aziendas?|co[-\\s]?operatives?|co[-\\s]?ops?|vignerons?'
  + '|houses?|châteaux|chateaux)\\b'
  + '|\\ban?\\s+(?:[\\w\\u00C0-\\u024F\'’-]+\\s+){0,3}producers?\\b',
  'i'
);

// The note asserts it is a COMMERCIAL NAME rather than a producer.
const BRAND_CLASS = /\b(brands?|labels?|ranges?|retailers?|supermarkets?|bottlers?|bottling|importers?|merchants?|lines?|own[-\s]?label|private[-\s]?label|marketing|cuvée name|cuvee name|trade name|generic)\b/i;

// Everything after one of these describes what the entity is NOT. Both shapes
// occur in prod: the contrastive ("a brand rather than an estate") and the
// failed-verification ("could not be verified as an established winery") —
// the second one names a producer noun while DENYING it, so it has to cut too.
const CONTRAST = /\b(rather than|instead of|not an? |but not |could not be|cannot be|can not be|can't be|unable to|never been)/i;

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
  const b = text.search(BRAND_CLASS);
  if (b === -1) return true;           // producer claim, nothing contradicting it
  return p < b;                        // whichever the note reached for first
}

module.exports = { noteAssertsProducer, PRODUCER_CLASS, BRAND_CLASS, CONTRAST };
