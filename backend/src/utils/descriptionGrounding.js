/**
 * Does a published description claim a PLACE (or variety) for the wine that
 * the record does not carry — and if so, does it ASSERT it or DISCLOSE it?
 *
 * WHY (somm ticket 6a82bfb7, resolved design 2026-08-20). The enrichment
 * wrote prose like "a soft, approachable red blend from the Hunter Valley"
 * onto records whose region is deliberately null — and a curator who trusts
 * the prose reproduces the fabrication in a sommelier note, which is exactly
 * what happened on four Worthington's drink windows. 61 published AI rows
 * currently carry a description with no region, no appellation and no grapes
 * on the record.
 *
 * THE AXIS IS ASSERTION vs DISCLOSURE, NOT TRUTH (the somm's correction to
 * my first framing, and they were right). The best available prose for a
 * null-region record NAMES places in order to say the place is unknown:
 *
 *   "They also draw fruit from across the Hunter, Mudgee, Armidale and New
 *    England as well as Barossa, McLaren Vale, Eden Valley and Clare Valley,
 *    so the region is genuinely open. Grape, region and tier are all
 *    unconfirmed…"                          (Petersons — the ALLOW fixture)
 *
 * A truth-blind extraction check would flag that paragraph eight times over,
 * and the cheapest way to pass would be deleting it — training enrichment
 * away from disclosure and toward blank confidence. So ungrounded claims are
 * GRADED, never just counted:
 *
 *   'assertion'  — an ungrounded place stated as fact for the wine. The
 *                  17 Aug Maureen's line above. The class the check exists for.
 *   'disclosure' — ungrounded places, but framed by uncertainty. Reviewable,
 *                  not wrong.
 *   'ok'         — nothing ungrounded.
 *
 * FRAMING IS HYBRID, by construction from the fixtures:
 *   - a STRONG disclosure marker anywhere frames the whole description,
 *     because disclosure paragraphs open with true producer biography
 *     ("founded at Mount View in the Hunter Valley in 1971") sentences ahead
 *     of the marker — sentence-scope alone would flag the somm's own ALLOW
 *     fixture on its first sentence;
 *   - a WEAK hedge ("likely", "may be") frames only its own sentence — one
 *     hedged clause must not launder a paragraph of assertions.
 *
 * This is the published-row AUDIT check. It deliberately does NOT share
 * strictness with the enrichment downgrade blocker (notePlaceConflict):
 * the blocker gates generation, where a wrong profile costs an owner
 * immediately; this grades rows that are already live, some of which are
 * already doing the right thing. The somm asked for that separation
 * explicitly and it is load-bearing.
 */

const normPlace = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Prepositional origin claims: "from the Hunter Valley", "at Mount View",
// "of Australia". Anchored on the preposition so ordinary capitalised
// sentence-starts never capture. Continuation tokens are Capitalised words or
// the lowercase connectors that live INSIDE place names (Côtes de Gascogne,
// Île de Ré) — a bare "in"/"the" ends the chain, otherwise "Mount View in the
// Hunter Valley" captures as one mangled claim and swallows the real one.
// Longest-first, with a trailing boundary — "de" listed ahead of "del" bites
// the first two letters of "Ribera del Duero" and truncates the claim. "y"
// added from the somm's v1.147 audit: without it "Castilla y León" broke at
// the conjunction and reported a truncated claim.
const PLACE_CONNECTOR = "(?:della|delle|del|des|de|di|du|da|dos|das|la|les|le|los|von|van|der|den|sur|en|y)(?=\\s)";
// Elided tokens — d'Avola, l'Étoile — start lowercase but are PART of the
// name, not a chain break (somm 6a87053b: stopping before them captured bare
// "Nero" out of the record's own Nero d'Avola).
const ELIDED_TOKEN = "[dl]['’][A-ZÀ-Þ][\\wÀ-ɏ'’-]*";
const PREP_CLAIM = new RegExp(
  "\\b(?:from|in|at|of|across|near)\\s+(?:the\\s+)?" +
  "([A-ZÀ-Þ][\\wÀ-ɏ'’-]*(?:\\s+(?:" + PLACE_CONNECTOR + "|" + ELIDED_TOKEN + "|[A-ZÀ-Þ][\\wÀ-ɏ'’-]*)){0,3})",
  'g'
);

// Keyword-suffixed claims: "Champagne appellation", "American style". The
// continuation chain is the SAME capitalised-or-connector rule as PREP_CLAIM —
// a free continuation captured junk like "It's a crowd-pleasing style" and
// "Details on producer and origin" in the first prod dry run.
const KEYWORD_CLAIM = new RegExp(
  "\\b([A-ZÀ-Þ][\\wÀ-ɏ'’-]*(?:\\s+(?:" + PLACE_CONNECTOR + "|" + ELIDED_TOKEN + "|[A-ZÀ-Þ][\\wÀ-ɏ'’-]*)){0,3})" +
  "\\s+(?:appellation|AOC|AOP|DOCG?|region|style|styles)\\b",
  'g'
);

// Materials and techniques, not origins: "aged in French oak", "Champagne
// method". Without this every barrel regime in the registry block-grades.
const MATERIAL_NOISE = /\b(oak|barriques?|barrels?|casks?|cooperage|hogsheads?|method|méthode|fashion|manner)\b/i;

// Tier and sweetness terms that capture capitalised before "style" but name a
// CATEGORY, not a place ("the traditional Reserva style"). A claim that is
// nothing but tier words is dropped; a real place carrying one ("Rioja
// Reserva") survives because grounding runs on the whole phrase.
const TIER_WORD = /^(reservas?|riservas?|crianzas?|gran|brut|extra|demi-sec|sec|secco?|dolce|trocken|halbtrocken|feinherb|classico|superiore|premium|prestige|tradition|traditional|vintage|blanc|rouge|rosé|rosado|tinto|crémants?|cremants?|reserve)$/i;

// Climate adjectives are weather, not origin — "Atlantic-influenced whites"
// asserts nothing about where the wine is from (found in the v1.148 re-count).
const CLIMATE_WORD = /^(atlantic|mediterranean|continental)/i;

// Frames strong enough to cover the whole description — the vocabulary of a
// paragraph whose JOB is saying what is unknown.
const STRONG_FRAME = /\b(could not be (?:identified|verified|confirmed)|cannot be (?:identified|verified|confirmed)|unconfirmed|unverified|unidentified|not (?:yet )?(?:known|identified|verified|confirmed)|genuinely open|unavailable|no drink window|if your label)\b/i;

// Hedges that frame only their own sentence.
const WEAK_FRAME = /\b(likely|probably|possibly|perhaps|presumably|may be|might be|appears? to be|seems? to be|uncertain)\b/i;

const STOP_FIRST = new Set(['this', 'the', 'that', 'these', 'those', 'it', 'its', "it's", 'it’s', 'a', 'an', 'if', 'they', 'expect', 'details']);

// Country adjectives ground against their country ("Canadian climates" on a
// Canada record, "French Crémant" on France). Substring grounding covers
// Spanish/Spain by accident of spelling and misses Canadian/Canada — a map is
// honest about what this is. Wine countries only; anything absent simply
// stays ungrounded, which fails toward review.
const DEMONYMS = {
  french: 'france', italian: 'italy', spanish: 'spain', german: 'germany',
  portuguese: 'portugal', austrian: 'austria', hungarian: 'hungary',
  greek: 'greece', american: 'united states', californian: 'united states',
  australian: 'australia', canadian: 'canada', chilean: 'chile',
  argentine: 'argentina', argentinian: 'argentina', dutch: 'netherlands',
  swiss: 'switzerland', georgian: 'georgia', croatian: 'croatia',
  romanian: 'romania', bulgarian: 'bulgaria', moldovan: 'moldova',
  slovenian: 'slovenia', uruguayan: 'uruguay', mexican: 'mexico',
  'south african': 'south africa', 'new zealand': 'new zealand',
};

// A place after one of these verbs is where something was CREATED, not where
// this wine is from — "a cold-hardy hybrid grape bred in Minnesota" on a
// French wine (somm v1.147 audit, item 5; one row, but the shape is a verb
// governing the phrase, so the rule is cheap and principled).
const CREATION_VERB = /\b(?:bred|crossed|hybridi[sz]ed|developed)\s*$/i;

function extractClaims(sentence) {
  const out = [];
  for (const rx of [PREP_CLAIM, KEYWORD_CLAIM]) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(sentence)) !== null) {
      const raw = m[1].trim();
      if (MATERIAL_NOISE.test(raw)) continue;
      if (CREATION_VERB.test(sentence.slice(0, m.index))) continue;
      // The connector-aware chain stops BEFORE a lowercase material word, so
      // "in French oak" captures bare "French" — look one word past the match:
      // a material/technique noun means this names a thing, not an origin.
      const following = sentence.slice(m.index + m[0].length).trimStart();
      if (MATERIAL_NOISE.test(following.split(/\s+/)[0] || '')) continue;
      // Drop bare years, then tier-only captures ("Reserva" before "style").
      const tokens = raw.split(/\s+/).filter((t) => !/^\d+$/.test(t));
      if (!tokens.length) continue;
      if (STOP_FIRST.has(tokens[0].toLowerCase())) continue;
      if (tokens.every((t) => TIER_WORD.test(t))) continue;
      const claim = tokens.join(' ');
      if (normPlace(claim).length < 3) continue;
      out.push(claim);
    }
  }
  return [...new Set(out)];
}

// Strip a possessive before normalising a token — "Chile's" and "Mendoza's"
// are the places, not new words (somm v1.147 audit, item 6).
const tokenNorm = (t) => normPlace(String(t).replace(/['’]s$/i, ''));

/**
 * @param {string} description  aiProfile.description as stored
 * @param {object} record       { region, appellation, country, producer } —
 *                              names, and optionally grapes: [names]
 * @returns {{ grade: 'ok'|'disclosure'|'assertion',
 *             claims: Array<{claim: string, framed: boolean}> }}
 *          claims lists only the UNGROUNDED ones — grounded mentions are the
 *          description doing its job and are not reported.
 *
 * Grounding is TOKEN SUBTRACTION, not span substring (somm v1.147 audit,
 * item 1 — the decisive one). Span-substring let the record's country ground
 * "Chile's Maipo Valley" wholesale, silently swallowing the finer place, and
 * a check that under-reports on rows it already flags gives a curator false
 * assurance — worse than over-reporting. Instead: remove every token the
 * record accounts for (its places, its grapes, its country's adjective, the
 * producer's own name) and whatever CAPITALISED tokens survive are the claim.
 * "Chile's Maipo Valley" − Chile → "Maipo Valley". "Bodega Fernando Dupont's
 * Jujuy" − producer → "Jujuy". Nothing capitalised left → nothing claimed.
 */
function gradeDescription(description, { region, appellation, country, grapes, producer, varietyVocabulary } = {}) {
  if (typeof description !== 'string' || !description.trim()) return { grade: 'ok', claims: [] };

  // Everything the record itself accounts for, kept as WHOLE token sequences.
  // The producer's tokens are in the same pool: a description mentioning the
  // producer is not claiming a place, however place-like the name reads (somm
  // item 2 — three of four disclosure rows were the producer's own name, so
  // the whole disclosure bucket was extraction noise wearing a calibrated
  // look). Sequences, not a token set, because grapes share tokens: with the
  // record carrying Cabernet SAUVIGNON, a loose-token pool subtracts the
  // "Cabernet" out of an ungrounded Cabernet FRANC claim and reports "Franc".
  const grounds = [];
  for (const src of [region, appellation, country, producer, ...(Array.isArray(grapes) ? grapes : [])]) {
    const seq = String(src || '').split(/\s+/).map(tokenNorm).filter(Boolean);
    if (seq.length) grounds.push(seq);
  }
  const nCountry = normPlace(country);
  for (const [adj, c] of Object.entries(DEMONYMS)) {
    if (c === nCountry) grounds.push(adj.split(' '));
  }

  // A norm-token run sitting INSIDE a ground sequence is grounded — "Château
  // Bois" inside producer "Chateau Bois D'Arlene", bare "Nero" inside grape
  // "Nero d'Avola" (somm 6a87053b). A truncated capture of a name the record
  // accounts for grounds even when shorter than the name. NOT the inverse:
  // "Cabernet Franc" is not inside "Cabernet Sauvignon".
  const insideAnyGround = (runNorms) => {
    if (!runNorms.length) return false;
    return grounds.some((seq) => {
      for (let i = 0; i + runNorms.length <= seq.length; i++) {
        if (runNorms.every((n, j) => seq[i + j] === n)) return true;
      }
      return false;
    });
  };

  const docFramed = STRONG_FRAME.test(description);
  const sentences = description.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const claims = [];

  const vocabSeqs = (Array.isArray(varietyVocabulary) ? varietyVocabulary : [])
    .filter((name) => !NON_VARIETY_VOCAB.has(normPlace(name)))
    .map((name) => ({ name, seq: String(name).split(/\s+/).map(tokenNorm).filter(Boolean) }))
    .filter((v) => v.seq.length);

  for (const sentence of sentences) {
    const sentenceFramed = docFramed || STRONG_FRAME.test(sentence) || WEAK_FRAME.test(sentence);

    // Variety pass FIRST (somm 6a870548): the extraction grammar catches only
    // the variety a preposition happens to introduce — "blended with small
    // amounts of Cabernet Franc, Petit Verdot and Merlot" reported one of
    // three. A vocabulary scan over the whole normalised sentence reports
    // every ungrounded variety regardless of position, including bare varietal
    // openers ("a full-bodied Tempranillo from…") and hyphen compounds
    // ("Syrah-led" normalises to "syrah led").
    if (vocabSeqs.length) {
      const sentNorms = normPlace(sentence).split(' ').filter(Boolean);
      for (const { name, seq } of vocabSeqs) {
        let found = false;
        for (let i = 0; i + seq.length <= sentNorms.length && !found; i++) {
          found = seq.every((n, j) => sentNorms[i + j] === n);
        }
        if (!found) continue;
        if (insideAnyGround(seq)) continue; // the record's own grape
        const key = normPlace(name);
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ claim: name, kind: 'variety', framed: sentenceFramed });
      }
    }

    for (const span of extractClaims(sentence)) {
      const tokens = span.split(/\s+/).map((t) => t.replace(/['’]s$/i, ''));
      const norms = tokens.map(tokenNorm);
      // Remove every CONTIGUOUS occurrence of a ground sequence.
      const removed = new Array(tokens.length).fill(false);
      for (const seq of grounds) {
        for (let i = 0; i + seq.length <= norms.length; i++) {
          if (seq.every((g, j) => norms[i + j] === g)) {
            for (let j = 0; j < seq.length; j++) removed[i + j] = true;
          }
        }
      }
      // Survivors also shed tier and climate words: once the record's own
      // tokens are subtracted, "French Crémant" leaves bare "Crémant" — a
      // style noun that only LOOKED like a place while attached to one.
      const left = tokens
        .map((t, i) => ({ t, n: norms[i], removed: removed[i] }))
        .filter(({ t, n, removed: r }) => !r && n && !TIER_WORD.test(t) && !CLIMATE_WORD.test(t));
      if (insideAnyGround(left.map(({ n }) => n))) continue;
      // Only capitalised survivors assert anything — "Barossa Valley shiraz"
      // on a Barossa Valley record leaves lowercase "shiraz", which is prose,
      // not a claim.
      if (!left.some(({ t }) => /^[A-ZÀ-Þ]/.test(t))) continue;
      const claim = left.map(({ t }) => t).join(' ');
      const key = normPlace(claim);
      if (seen.has(key)) continue;
      seen.add(key);
      const isVariety = vocabSeqs.some((v) => normPlace(v.name) === key);
      claims.push({ claim, kind: isVariety ? 'variety' : 'place', framed: sentenceFramed });
    }
  }

  if (!claims.length) return { grade: 'ok', claims: [] };
  return { grade: claims.some((c) => !c.framed) ? 'assertion' : 'disclosure', claims };
}

// Taxonomy entries that exist ONLY for quarantined non-wine rows (cider,
// mead — see ticket 6a86bb5f): they are legitimate grape-collection entries
// but poison a variety vocabulary, because every tasting note mentioning
// "green apple acidity" or "pear fruit" would report a variety claim. 17 of
// 21 assertion rows in the first vocabulary-pass dry run were this.
const NON_VARIETY_VOCAB = new Set(['apple', 'pear', 'quince', 'honey']);

module.exports = { gradeDescription, extractClaims, STRONG_FRAME, WEAK_FRAME, normPlace, NON_VARIETY_VOCAB };
