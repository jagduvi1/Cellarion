const { localizedName, baseLanguage, sanitizeTranslations } = require('./localizedName');

// The record that prompted this: proposal 6a959b9d, "En Français svp".
const rhone = { name: 'Rhône Valley', translations: { fr: 'Vallée du Rhône', de: 'Rhônetal' } };
const asMap = (obj) => ({ ...obj, translations: new Map(Object.entries(obj.translations)) });

describe('localizedName', () => {
  test('gives the French reader the French name', () => {
    expect(localizedName(rhone, 'fr')).toBe('Vallée du Rhône');
  });

  test('works on a Mongoose Map as well as a lean object', () => {
    // Both shapes reach this function. Reading only one is how a feature
    // passes its tests and silently does nothing in production.
    expect(localizedName(asMap(rhone), 'fr')).toBe('Vallée du Rhône');
    expect(localizedName(asMap(rhone), 'sv')).toBe('Rhône Valley');
  });

  test('a regional variant reads the base language', () => {
    // fr-CA is not a different wine region. Withholding a good French name
    // from a Canadian reader would be pedantry with a cost.
    expect(localizedName(rhone, 'fr-CA')).toBe('Vallée du Rhône');
    expect(localizedName(rhone, 'de_AT')).toBe('Rhônetal');
  });

  test('falls back to the canonical name for an untranslated language', () => {
    expect(localizedName(rhone, 'sv')).toBe('Rhône Valley');
    expect(localizedName(rhone, 'et')).toBe('Rhône Valley');
  });

  test('English always gets the canonical name, never a translation', () => {
    expect(localizedName({ ...rhone, translations: { ...rhone.translations, en: 'The Rhone' } }, 'en'))
      .toBe('Rhône Valley');
  });

  test.each([
    [{ name: 'Mosel' }, 'fr', 'Mosel', 'no translations at all'],
    [{ name: 'Mosel', translations: {} }, 'fr', 'Mosel', 'an empty map'],
    [{ name: 'Mosel', translations: { fr: '   ' } }, 'fr', 'Mosel', 'a blank translation'],
    [{ name: 'Mosel', translations: { fr: 42 } }, 'fr', 'Mosel', 'a non-string translation'],
    [rhone, null, 'Rhône Valley', 'no locale'],
    [rhone, '', 'Rhône Valley', 'an empty locale'],
    [rhone, 'not-a-language', 'Rhône Valley', 'nonsense'],
  ])('%p in %p → %p (%s)', (doc, locale, expected) => {
    expect(localizedName(doc, locale)).toBe(expected);
  });

  test('a doc with no name yields an empty string rather than throwing', () => {
    expect(localizedName(null, 'fr')).toBe('');
    expect(localizedName({}, 'fr')).toBe('');
  });
});

describe('baseLanguage', () => {
  test.each([['fr', 'fr'], ['FR', 'fr'], ['fr-CA', 'fr'], ['de_AT', 'de'], ['  sv  ', 'sv']])(
    '%p → %p', (input, expected) => expect(baseLanguage(input)).toBe(expected),
  );
  test.each([[''], ['x'], ['1234'], [null], [undefined], [42], [{}]])('%p → null', (input) => {
    expect(baseLanguage(input)).toBeNull();
  });
});

describe('sanitizeTranslations', () => {
  test('keeps and trims real pairs', () => {
    expect(sanitizeTranslations({ fr: '  Vallée du Rhône ', de: 'Rhônetal' }))
      .toEqual({ ok: true, translations: { fr: 'Vallée du Rhône', de: 'Rhônetal' } });
  });

  test('normalises the language key', () => {
    expect(sanitizeTranslations({ 'FR-ca': 'Vallée du Rhône' }).translations).toEqual({ fr: 'Vallée du Rhône' });
  });

  test('an empty value clears that language rather than storing a blank', () => {
    expect(sanitizeTranslations({ fr: '', de: null, sv: '  ' }).translations).toEqual({});
  });

  test('refuses English — the canonical name owns it', () => {
    // Two English spellings that can drift apart is a data mystery in waiting.
    expect(sanitizeTranslations({ en: 'The Rhone' })).toEqual({
      ok: false, error: 'English is the canonical name and cannot be a translation',
    });
  });

  test.each([
    [{ 'not a language': 'x' }, '"not a language" is not a language code'],
    [{ fr: 42 }, 'translation for "fr" must be a string'],
    [{ fr: 'x'.repeat(121) }, 'translation for "fr" is longer than 120 characters'],
    [['fr'], 'translations must be an object of language → name'],
    ['fr', 'translations must be an object of language → name'],
  ])('rejects %p', (raw, error) => {
    expect(sanitizeTranslations(raw)).toEqual({ ok: false, error });
  });

  test('null is an empty set, not an error — clearing everything is legitimate', () => {
    expect(sanitizeTranslations(null)).toEqual({ ok: true, translations: {} });
  });
});
