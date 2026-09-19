/**
 * A wine's COLOUR, kept apart from its TYPE (support ticket 2026-09-17,
 * "Colour Sparkling/Rosè").
 *
 * WineDefinition.type is ONE value, and three of its six values — sparkling,
 * dessert, fortified — are STYLES that say nothing about colour (the
 * colour-contradiction rules in utils/crossFieldChecks.js already refuse to
 * judge them for exactly that reason). A Trento DOC rosé therefore had to be
 * filed either as 'sparkling' — right style, drawn in the sparkling colour on
 * every card and rack — or as 'rosé', which took it out of the Sparkling
 * group, its filters and its drink-window shape. The registry held 79 sparkling
 * rosés the first way and 11 the second.
 *
 * `WineDefinition.colour` records the colour for those three types only. For
 * red / white / rosé the type IS the colour and the field stays null — the
 * model's pre-validate hook enforces that, so a stale colour can never
 * contradict a later retype. Type stays single-valued on purpose: ~26 backend
 * files, the frontend and the MCP responses read it as one value, and an MCP
 * response field must never change shape in place (docs/mcp-versioning.md).
 */
const { normalizeString } = require('./normalize');

// Same spelling and values as WineDefinition.type's colour half.
const WINE_COLOURS = ['red', 'white', 'rosé'];
// The types that carry no colour of their own.
const STYLE_TYPES = ['sparkling', 'dessert', 'fortified'];

// Rosé words a NAME carries, pre-normalized (normalizeString folds "Rosé" and
// "Rosè" to 'rose'). The rosé entries of crossFieldChecks' NAME_COLOUR_TERMS —
// pinned by a drift test so the two vocabularies cannot part.
//
// Deliberately rosé ONLY, never the red or white words: "Cordon Rouge" is a
// white Champagne, and "Blanc de Blancs" is what an uncoloured sparkling wine
// already is. Rosé is the one colour that is both reliable in a name and drawn
// differently from the style's own swatch.
const ROSE_NAME_WORDS = ['rose', 'rosato', 'rosado', 'blush'];
const ROSE_WORD_SET = new Set(ROSE_NAME_WORDS);

function isStyleType(type) {
  return STYLE_TYPES.includes(type);
}

function isWineColour(value) {
  return WINE_COLOURS.includes(value);
}

// normalizeString DELETES punctuation, so "Brut-Rosé" would fold to one token
// ('brutrose') and never match — punctuation becomes a word break first.
function tokens(str) {
  const spaced = String(str || '').replace(/[\p{P}\p{S}]+/gu, ' ');
  return normalizeString(spaced).split(' ').filter(Boolean);
}

/**
 * The colour a style-typed wine's NAME states, or null when it states none.
 * A word the producer's name also carries says nothing about THIS wine
 * ("Château La Rose — Brut" is not a rosé), the same exclusion the
 * colour-contradiction rule makes.
 */
function inferColourFromName(name, producer) {
  const producerTokens = new Set(tokens(producer));
  for (const t of tokens(name)) {
    if (ROSE_WORD_SET.has(t) && !producerTokens.has(t)) return 'rosé';
  }
  return null;
}

/**
 * The colour a wine IS: its type for red/white/rosé, its recorded colour for
 * sparkling/dessert/fortified, or null when neither says.
 */
function effectiveColour(wine) {
  if (!wine) return null;
  if (isWineColour(wine.type)) return wine.type;
  if (isStyleType(wine.type) && isWineColour(wine.colour)) return wine.colour;
  return null;
}

module.exports = {
  WINE_COLOURS,
  STYLE_TYPES,
  ROSE_NAME_WORDS,
  isStyleType,
  isWineColour,
  inferColourFromName,
  effectiveColour,
};
