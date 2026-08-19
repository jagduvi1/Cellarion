/**
 * Grape-colour contradiction: does the stored `type` disagree with the colour
 * of EVERY grape on the wine?
 *
 * A sibling of the `colour-contradiction.v2` rule in utils/crossFieldChecks —
 * and deliberately not a replacement for it. That one reads the wine's NAME
 * ("Bianco" on a red); this one reads its GRAPES. Neither subsumes the other:
 * "Domaine des Bosquets / Séguret" is stored red with Viognier, Roussanne and
 * Marsanne and carries no colour word at all, so only the grape rule sees it.
 *
 * WHY THIS EXISTS (somm ticket 6a85ad44, 2026-08-19). Two wines were minted by
 * a live import forty minutes AFTER v1.139.0 shipped the prompt rules meant to
 * stop exactly this — a red given "Sauvignon Blanc", a red given "Grenache
 * Blanc". Prompt instructions ask a model not to guess; they cannot make it
 * stop. A deterministic check over curated taxonomy can, and it costs nothing.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN. The directions are not equally
 * suspicious, and treating them alike would bury the real errors:
 *
 *   red from grapes that are ALL white — no legitimate case. Colour comes
 *       from skin contact with dark grapes, so either the type is wrong or the
 *       grape list is (a Côte-Rôtie listing only its Viognier lands here too,
 *       and that is also worth a look). No exemption.
 *
 *   white from grapes that are ALL red — an ordinary, deliberate style.
 *       Blanc de noirs, Bianco di Morgante, Pinotage Blanc. Flagging these
 *       would make the check ~50% noise on real prod data, which is how a
 *       review queue gets ignored. The wine tells us when it means it: the
 *       NAME carries the white word. So that direction flags only when the
 *       name is silent — "Tokara / Director's Reserve" stored white on four
 *       Bordeaux red varieties says nothing, and is simply wrong.
 *
 *   rosé — NOT JUDGED AT ALL, and the first draft of this file got that wrong.
 *       Run over the live registry it flagged seven rosés from "white" grapes,
 *       and four were real wines: Canaletto's Rosato is ramato Pinot Gris,
 *       Alain Ignace's Muscat de Beaumes-de-Venise Rosé is the pink Muscat
 *       mutation our taxonomy only carries as "Muscat Blanc", and both
 *       Hammeken's Nanit and Charles Frey's Macération are skin-contact ORANGE
 *       wines — which have no `type` of their own, so rosé is the honest
 *       choice a curator has. Two causes, one conclusion: Grape.color is a
 *       Red/White binary that cannot express a pink skin, and rosé is exactly
 *       where that gap lives. Judging it would spend the queue's credibility
 *       on wines that are already correct.
 *
 * Measured against the live registry 2026-08-19: 13 rows flagged out of 5,727
 * with grapes (0.23%). Every legitimate blanc de noirs is exempted by its own
 * name; every genuine defect flags.
 *
 * FLAG, NEVER AUTO-FIX. The check knows the two fields disagree; it does not
 * know which one is wrong (Tyrrell's "Old Hut Semillon" is stored white with
 * Syrah — there the GRAPE is the error, not the type). A human decides.
 */
const { normalizeString } = require('./normalize');

// Colour words that, in a wine's own name, are a deliberate claim about the
// wine in the glass. Mirrors NAME_COLOUR_TERMS in utils/crossFieldChecks —
// kept as its own list because this rule only ever asks about WHITE.
const WHITE_NAME_TERMS = new Set(['blanc', 'blancs', 'blanco', 'bianco', 'branco', 'weiss', 'weisser', 'white']);

// The types this rule will judge. 'sparkling', 'dessert' and 'fortified' say
// nothing about colour — a Blanc de Noirs Champagne and a white Port are both
// stored under them. 'rosé' is excluded for the measured reason in the header:
// pink-skinned varieties and orange wines both live there, and Grape.color's
// Red/White binary cannot tell either of them apart from a defect.
const COLOUR_TYPES = new Set(['red', 'white']);

const tokensOf = (s) => normalizeString(String(s || '').replace(/ß/g, 'ss')).split(' ').filter(Boolean);

/**
 * @param {object} wine  { type, name, producer, grapes: [{ name, color }] }
 *                       `grapes` must be POPULATED with `color` — an unpopulated
 *                       id array yields no colours and the check stays silent,
 *                       which is the safe direction.
 * @returns {string|null} short human detail (what disagreed), or null
 */
function findGrapeColourConflict(wine) {
  const type = wine?.type;
  if (!COLOUR_TYPES.has(type)) return null;

  const grapes = Array.isArray(wine?.grapes) ? wine.grapes : [];
  if (!grapes.length) return null;

  // Every grape must carry a curated colour. One unknown grape and the wine is
  // simply not evaluable — a partial verdict here would be a guess, which is
  // the failure mode this whole check exists to answer.
  const colours = grapes.map((g) => g && g.color).filter(Boolean);
  if (colours.length !== grapes.length) return null;

  const names = grapes.map((g) => g.name).filter(Boolean).join(', ');
  const allWhite = colours.every((c) => c === 'White');
  const allRed = colours.every((c) => c === 'Red');

  if (type === 'red' && allWhite) {
    return `stored red, but every grape is white (${names})`;
  }

  if (type === 'white' && allRed) {
    // Blanc de noirs exemption. A colour word that is also in the PRODUCER is
    // the estate's name rather than a claim about the wine ("Mas Blanc"), the
    // same carve-out colour-contradiction.v2 makes — so producer tokens do not
    // earn the exemption.
    const producerTokens = new Set(tokensOf(wine.producer));
    const claimsWhite = tokensOf(wine.name).some((t) => WHITE_NAME_TERMS.has(t) && !producerTokens.has(t));
    if (claimsWhite) return null; // deliberate white-from-red-grapes
    return `stored white, but every grape is red (${names}) and the name makes no white claim`;
  }

  return null;
}

module.exports = { findGrapeColourConflict, WHITE_NAME_TERMS, COLOUR_TYPES };
