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
// the first two letters of "Ribera del Duero" and truncates the claim.
const PLACE_CONNECTOR = "(?:della|delle|del|des|de|di|du|da|dos|das|la|les|le|los|von|van|der|den|sur|en)(?=\\s)";
const PREP_CLAIM = new RegExp(
  "\\b(?:from|in|at|of|across|near)\\s+(?:the\\s+)?" +
  "([A-ZÀ-Þ][\\wÀ-ɏ'’-]*(?:\\s+(?:" + PLACE_CONNECTOR + "|[A-ZÀ-Þ][\\wÀ-ɏ'’-]*)){0,3})",
  'g'
);

// Keyword-suffixed claims: "Champagne appellation", "American style". The
// continuation chain is the SAME capitalised-or-connector rule as PREP_CLAIM —
// a free continuation captured junk like "It's a crowd-pleasing style" and
// "Details on producer and origin" in the first prod dry run.
const KEYWORD_CLAIM = new RegExp(
  "\\b([A-ZÀ-Þ][\\wÀ-ɏ'’-]*(?:\\s+(?:" + PLACE_CONNECTOR + "|[A-ZÀ-Þ][\\wÀ-ɏ'’-]*)){0,3})" +
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
const TIER_WORD = /^(reservas?|riservas?|crianzas?|gran|brut|extra|demi-sec|sec|secco?|dolce|trocken|halbtrocken|feinherb|classico|superiore|premium|prestige|tradition|traditional|vintage|blanc|rouge|rosé|rosado|tinto)$/i;

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

function extractClaims(sentence) {
  const out = [];
  for (const rx of [PREP_CLAIM, KEYWORD_CLAIM]) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(sentence)) !== null) {
      const raw = m[1].trim();
      if (MATERIAL_NOISE.test(raw)) continue;
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

/**
 * @param {string} description  aiProfile.description as stored
 * @param {object} record       { region, appellation, country } — names, and
 *                              optionally grapes: [names] for variety grounding
 * @returns {{ grade: 'ok'|'disclosure'|'assertion',
 *             claims: Array<{place: string, framed: boolean}> }}
 *          claims lists only the UNGROUNDED ones — grounded mentions are the
 *          description doing its job and are not reported.
 */
function gradeDescription(description, { region, appellation, country, grapes } = {}) {
  if (typeof description !== 'string' || !description.trim()) return { grade: 'ok', claims: [] };

  const ground = [region, appellation, country, ...(Array.isArray(grapes) ? grapes : [])]
    .map(normPlace)
    .filter(Boolean);

  const docFramed = STRONG_FRAME.test(description);
  const sentences = description.split(/(?<=[.!?])\s+/);
  const claims = [];

  for (const sentence of sentences) {
    const sentenceFramed = docFramed || STRONG_FRAME.test(sentence) || WEAK_FRAME.test(sentence);
    for (const place of extractClaims(sentence)) {
      const n = normPlace(place);
      // Expand country adjectives before comparing, so "Canadian" can ground
      // against a Canada record the way "Spanish"/"Spain" grounds by luck.
      const expanded = Object.entries(DEMONYMS).reduce(
        (acc, [adj, country]) => (acc.includes(adj) ? acc.replace(adj, country) : acc), n
      );
      const grounded = ground.some((g) =>
        g.includes(n) || n.includes(g) || g.includes(expanded) || expanded.includes(g)
      );
      if (grounded) continue;
      claims.push({ place, framed: sentenceFramed });
    }
  }

  if (!claims.length) return { grade: 'ok', claims: [] };
  return { grade: claims.some((c) => !c.framed) ? 'assertion' : 'disclosure', claims };
}

module.exports = { gradeDescription, extractClaims, STRONG_FRAME, WEAK_FRAME, normPlace };
