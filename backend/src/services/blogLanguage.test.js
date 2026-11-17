// How a translation is labelled, and the slug a post in another language
// gets. What the blog lists, and the language links between versions, run on
// MongoDB in routes/blog.languages.mongo.test.js.
jest.mock('../models/BlogPost', () => ({}));

const { nativeLanguageName } = require('./blogLanguage');
const { generateSlug } = require('../routes/blog');

describe('nativeLanguageName', () => {
  test('a language in its own words, capitalised: what a reader of it looks for', () => {
    expect(nativeLanguageName('sv')).toBe('Svenska');
    expect(nativeLanguageName('fr')).toBe('Français');
    expect(nativeLanguageName('de')).toBe('Deutsch');
  });

  test('a code the runtime cannot name is shown as itself', () => {
    expect(nativeLanguageName('zz')).toMatch(/^zz$/i);
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
