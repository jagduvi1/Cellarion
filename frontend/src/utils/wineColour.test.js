import { swatchType, wineTypeLabel, recordedColour, isStyleType, colourLabel, WINE_COLOURS, STYLE_TYPES } from './wineColour';
import en from '../locales/en/translation.json';

// The app's t(): the inline fallback, like every component test mocks it.
const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

describe('recordedColour', () => {
  test('only a sparkling, dessert or fortified wine carries one', () => {
    expect(recordedColour({ type: 'sparkling', colour: 'rosé' })).toBe('rosé');
    expect(recordedColour({ type: 'fortified', colour: 'white' })).toBe('white');
    // The type already is the colour — a stray value is not read.
    expect(recordedColour({ type: 'white', colour: 'rosé' })).toBeNull();
    expect(recordedColour({ type: 'sparkling', colour: null })).toBeNull();
    expect(recordedColour({ type: 'sparkling', colour: 'orange' })).toBeNull();
    expect(recordedColour(null)).toBeNull();
  });
});

describe('swatchType', () => {
  test('a sparkling rosé or red is drawn in its colour (the ticket)', () => {
    expect(swatchType({ type: 'sparkling', colour: 'rosé' })).toBe('rosé');
    expect(swatchType({ type: 'sparkling', colour: 'red' })).toBe('red');
  });

  test('a white or colourless sparkling keeps the sparkling swatch', () => {
    expect(swatchType({ type: 'sparkling', colour: 'white' })).toBe('sparkling');
    expect(swatchType({ type: 'sparkling' })).toBe('sparkling');
  });

  test('dessert and fortified keep their own swatches whatever their colour', () => {
    expect(swatchType({ type: 'dessert', colour: 'white' })).toBe('dessert');
    expect(swatchType({ type: 'fortified', colour: 'red' })).toBe('fortified');
  });

  test('still wines are unchanged, and the caller\'s fallback covers an untyped wine', () => {
    expect(swatchType({ type: 'red' })).toBe('red');
    expect(swatchType({ type: 'rosé', colour: 'red' })).toBe('rosé');
    expect(swatchType({}, 'red')).toBe('red');
    expect(swatchType(null, 'red')).toBe('red');
    expect(swatchType(undefined)).toBeNull();
  });
});

describe('wineTypeLabel', () => {
  test('one phrase per style and colour', () => {
    expect(wineTypeLabel({ type: 'sparkling', colour: 'rosé' }, t)).toBe('Sparkling rosé');
    expect(wineTypeLabel({ type: 'dessert', colour: 'red' }, t)).toBe('Red dessert wine');
    expect(wineTypeLabel({ type: 'fortified', colour: 'white' }, t)).toBe('White fortified wine');
  });

  test('the plain type otherwise; null for an untyped wine', () => {
    expect(wineTypeLabel({ type: 'sparkling' }, t)).toBe('Sparkling');
    expect(wineTypeLabel({ type: 'red', colour: 'rosé' }, t)).toBe('Red');
    expect(wineTypeLabel({}, t)).toBeNull();
  });

  test('every combination has a translation key', () => {
    const seen = [];
    const spy = (key, fallback) => { seen.push(key); return fallback; };
    for (const type of STYLE_TYPES) {
      for (const colour of WINE_COLOURS) wineTypeLabel({ type, colour }, spy);
    }
    expect(seen).toHaveLength(9);
    expect(seen.every((k) => k.startsWith('wineColour.combined.'))).toBe(true);
  });

  test('en ships every combined label the helper asks for', () => {
    for (const type of STYLE_TYPES) {
      for (const colour of WINE_COLOURS) {
        expect(en.wineColour.combined[type][colour]).toEqual(wineTypeLabel({ type, colour }, t));
      }
    }
  });
});

test('isStyleType and colourLabel', () => {
  expect(STYLE_TYPES.every(isStyleType)).toBe(true);
  expect(isStyleType('rosé')).toBe(false);
  expect(colourLabel('rosé', t)).toBe('Rosé');
});
