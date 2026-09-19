/**
 * utils/wineColour — support ticket 2026-09-17 ("Colour Sparkling/Rosè").
 *
 * Pins the inference the model hook runs on every created or retyped
 * sparkling/dessert/fortified wine: rosé words only, whole words only, never a
 * word the producer's name carries — and that the vocabulary cannot drift from
 * the colour-contradiction rule's.
 */
const {
  WINE_COLOURS, STYLE_TYPES, ROSE_NAME_WORDS, isStyleType, isWineColour, inferColourFromName, effectiveColour,
} = require('./wineColour');
const { NAME_COLOUR_TERMS } = require('./crossFieldChecks');

describe('inferColourFromName', () => {
  test.each([
    ['Rosé Extra Brut', 'Maso Martis'],
    ['Brut Rosè', 'Ferrari'],             // grave accent, as the ticket spelled it
    ['ROSÉ', 'Billecart-Salmon'],
    ['Cuvée Rosato', 'Cantina X'],
    ['Cava Rosado Brut', 'Codorníu'],
    ['Brut-Rosé', 'Some House'],          // punctuation is a word break, not glue
    ['Blush Sparkling', 'Some House'],
  ])('%s → rosé', (name, producer) => {
    expect(inferColourFromName(name, producer)).toBe('rosé');
  });

  test('never infers red or white — "Cordon Rouge" is a white Champagne', () => {
    expect(inferColourFromName('Cordon Rouge', 'G.H. Mumm')).toBeNull();
    expect(inferColourFromName('Blanc de Blancs Brut', 'Maso Martis')).toBeNull();
    expect(inferColourFromName('Lambrusco Rosso', 'Cavicchioli')).toBeNull();
  });

  test('a word the producer also carries says nothing about this wine', () => {
    expect(inferColourFromName('Château La Rose Brut', 'Château La Rose')).toBeNull();
  });

  test('whole words only', () => {
    expect(inferColourFromName('Rosenberg Sekt', 'Weingut X')).toBeNull();
    expect(inferColourFromName('Roseto Spumante', 'Cantina Y')).toBeNull();
    expect(inferColourFromName('', 'x')).toBeNull();
    expect(inferColourFromName(null, null)).toBeNull();
  });
});

describe('effectiveColour', () => {
  test('the type for red/white/rosé, the recorded colour for a style, else null', () => {
    expect(effectiveColour({ type: 'rosé' })).toBe('rosé');
    expect(effectiveColour({ type: 'red', colour: 'white' })).toBe('red');
    expect(effectiveColour({ type: 'sparkling', colour: 'rosé' })).toBe('rosé');
    expect(effectiveColour({ type: 'sparkling', colour: null })).toBeNull();
    expect(effectiveColour({ type: 'dessert', colour: 'orange' })).toBeNull();
    expect(effectiveColour(null)).toBeNull();
  });
});

test('the vocabularies', () => {
  expect(STYLE_TYPES.every(isStyleType)).toBe(true);
  expect(WINE_COLOURS.every(isWineColour)).toBe(true);
  expect(isStyleType('rosé')).toBe(false);
  expect(isWineColour('sparkling')).toBe(false);
});

// The inference and the colour-contradiction rule must agree on what a rosé
// word is, or a name the rule flags would be one the hook fails to colour.
test('drift: the rosé words are exactly the rosé entries of NAME_COLOUR_TERMS', () => {
  const rose = [...NAME_COLOUR_TERMS].filter(([, implied]) => implied === 'rosé').map(([word]) => word).sort();
  expect([...ROSE_NAME_WORDS].sort()).toEqual(rose);
});

test('drift: WINE_COLOURS match the WineDefinition schema enum', () => {
  const WineDefinition = require('../models/WineDefinition');
  expect(WineDefinition.schema.path('colour').enumValues).toEqual(WINE_COLOURS);
  // …and the style types are the three schema types that are not a colour.
  const types = WineDefinition.schema.path('type').enumValues;
  expect(types.filter((t) => !WINE_COLOURS.includes(t))).toEqual(STYLE_TYPES);
});

// Audit 2026-09-19: a stated colour beats the hook's inference, and a colour
// the type cannot carry is refused instead of silently dropped.
describe('stateColour / colourTypeConflict', () => {
  const { stateColour, colourTypeConflict } = require('./wineColour');

  test('stateColour writes the value (null included) and marks the document', () => {
    const doc = { colour: 'rosé', $locals: {} };
    stateColour(doc, null);
    expect(doc.colour).toBeNull();
    expect(doc.$locals.colourStated).toBe(true);
    stateColour(doc, '');
    expect(doc.colour).toBeNull();
    stateColour(doc, 'red');
    expect(doc.colour).toBe('red');
  });

  test('stateColour works on a plain test double with no $locals', () => {
    const plain = {};
    expect(() => stateColour(plain, 'rosé')).not.toThrow();
    expect(plain.colour).toBe('rosé');
  });

  test('colourTypeConflict: null when storable or when nothing is being set', () => {
    expect(colourTypeConflict('sparkling', 'rosé')).toBeNull();
    expect(colourTypeConflict('fortified', 'red')).toBeNull();
    expect(colourTypeConflict('red', null)).toBeNull();
    expect(colourTypeConflict('red', undefined)).toBeNull();
    expect(colourTypeConflict('red', '')).toBeNull();
  });

  test('colourTypeConflict: says why, and the way out', () => {
    expect(colourTypeConflict('rosé', 'rosé')).toMatch(/typed rosé/);
    expect(colourTypeConflict(null, 'rosé')).toMatch(/not typed yet/);
    expect(colourTypeConflict('white', 'red')).toMatch(/correct the type in the same call/);
  });
});
