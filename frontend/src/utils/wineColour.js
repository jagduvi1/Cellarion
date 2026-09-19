/**
 * A wine's COLOUR, kept apart from its TYPE (support ticket 2026-09-17,
 * "Colour Sparkling/Rosè"). Mirrors backend/src/utils/wineColour.js.
 *
 * `wine.type` is one value, and three of its values — sparkling, dessert,
 * fortified — are styles that say nothing about colour. `wine.colour` records
 * it for exactly those three (a Trento DOC rosé is type 'sparkling', colour
 * 'rosé'); for red/white/rosé the type already is the colour and the field is
 * null.
 */

export const WINE_COLOURS = ['red', 'white', 'rosé'];
export const STYLE_TYPES = ['sparkling', 'dessert', 'fortified'];

export const isStyleType = (type) => STYLE_TYPES.includes(type);

/** The colour recorded for a style-typed wine, or null. */
export function recordedColour(wine) {
  if (!wine || !isStyleType(wine.type)) return null;
  return WINE_COLOURS.includes(wine.colour) ? wine.colour : null;
}

/**
 * The key every SWATCH is drawn with — bottle placeholders, type pills, rack
 * slots, 3D bottles, list dots. The wine's type, except that a sparkling rosé
 * or sparkling red takes its colour: the sparkling swatch is what a white
 * sparkling wine looks like, and drawing a rosé that way is exactly what the
 * ticket reported. Dessert and fortified keep their own swatches — those
 * already read as the style — and show their colour in the label instead.
 *
 * `fallback` is what the caller drew for an untyped wine before this helper
 * (racks default to 'red', pills to nothing), so no untyped swatch changes.
 */
export function swatchType(wine, fallback = null) {
  if (!wine) return fallback;
  const colour = recordedColour(wine);
  if (wine.type === 'sparkling' && (colour === 'rosé' || colour === 'red')) return colour;
  return wine.type || fallback;
}

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// English fallbacks for the combined labels (the t() default, like every other
// call site in the app). One whole phrase per combination, so each language
// can order the words its own way ("Mousserande rosé", "Rosé effervescent").
const COMBINED_FALLBACK = {
  sparkling: { red: 'Sparkling red', white: 'Sparkling white', 'rosé': 'Sparkling rosé' },
  dessert: { red: 'Red dessert wine', white: 'White dessert wine', 'rosé': 'Rosé dessert wine' },
  fortified: { red: 'Red fortified wine', white: 'White fortified wine', 'rosé': 'Rosé fortified wine' },
};

/**
 * The type as a reader should see it: "Sparkling rosé" when a colour is
 * recorded, otherwise the plain translated type. Null for an untyped wine.
 */
export function wineTypeLabel(wine, t) {
  const type = wine?.type;
  if (!type) return null;
  const colour = recordedColour(wine);
  if (colour) {
    return t(`wineColour.combined.${type}.${colour}`, COMBINED_FALLBACK[type][colour]);
  }
  return t(`statistics.typeLabels.${type}`, CAP(type));
}

/** A colour on its own ("Rosé"), for pickers — reuses the type labels. */
export const colourLabel = (colour, t) => t(`statistics.typeLabels.${colour}`, CAP(colour));
