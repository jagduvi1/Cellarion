// The reader language a request asks for, and the slug a post in another
// language gets. The family rule itself runs on MongoDB in
// routes/blog.languages.mongo.test.js.
jest.mock('../models/BlogPost', () => ({}));

const { readerLanguage } = require('./blogLanguage');
const { generateSlug } = require('../routes/blog');

describe('readerLanguage', () => {
  test('the base code of what the reader asks for', () => {
    expect(readerLanguage('sv')).toBe('sv');
    expect(readerLanguage('fr-CA')).toBe('fr');
    expect(readerLanguage('  DE ')).toBe('de');
  });

  test('English when the request names no usable language', () => {
    expect(readerLanguage(undefined)).toBe('en');
    expect(readerLanguage('')).toBe('en');
    expect(readerLanguage('9x')).toBe('en');
    // `?lang[$gt]=` reaches the route as an object.
    expect(readerLanguage({ $gt: '' })).toBe('en');
    expect(readerLanguage(['sv', 'fr'])).toBe('en');
  });
});

describe('generateSlug', () => {
  test('folds accents instead of dropping the letter', () => {
    expect(generateSlug('Fenêtres de dégustation')).toBe('fenetres-de-degustation');
    expect(generateSlug('Så flyttar du din vinkällare')).toBe('sa-flyttar-du-din-vinkallare');
    expect(generateSlug('Alternative à Oeni')).toBe('alternative-a-oeni');
  });

  test('spells out the letters that carry no separate accent', () => {
    expect(generateSlug('Kjøkken og ærlig')).toBe('kjokken-og-aerlig');
    expect(generateSlug('Weißwein')).toBe('weisswein');
  });

  test('an English title is unchanged', () => {
    expect(generateSlug('How to Move Your Wine Cellar from Oeni!')).toBe('how-to-move-your-wine-cellar-from-oeni');
  });
});
