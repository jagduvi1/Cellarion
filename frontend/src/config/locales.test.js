/**
 * The language menu is assembled from build-time coverage, so these assertions
 * use a synthetic set: the real build only has finished languages, and the
 * interesting behaviour is what happens to an unfinished one.
 */

vi.mock('virtual:locale-coverage', () => ({
  BETA_BELOW: 0.9,
  LIST_ABOVE: 0.1,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false },
    // 0.629 — deliberately not a round number: the label must round DOWN.
    { code: 'fr', translated: 629, total: 1000, ratio: 0.629, beta: true },
    // Below the listing floor: just requested in Weblate, nothing done yet.
    { code: 'de', translated: 5, total: 100, ratio: 0.05, beta: true },
  ],
  LOCALE_CODES: ['de', 'en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

const { LANGUAGE_OPTIONS, ALL_LANGUAGES, HAS_BETA_LANGUAGES, isBetaLanguage, findLanguage, languageOptionsFor } =
  await import('./locales');

describe('LANGUAGE_OPTIONS', () => {
  const byCode = (code) => ALL_LANGUAGES.find((l) => l.code === code);

  test('labels each language in its own language, capitalised', () => {
    expect(byCode('en').label).toBe('English');
    expect(byCode('sv').label).toBe('Svenska');
    expect(byCode('fr').label).toBe('Français');
    expect(byCode('de').label).toBe('Deutsch');
  });

  test('finished languages come first, each group alphabetical', () => {
    expect(ALL_LANGUAGES.map((l) => l.code)).toEqual(['en', 'sv', 'de', 'fr']);
  });

  test('omits a language too empty to be worth choosing', () => {
    // Weblate writes the locale file the moment a language is requested, so
    // without this the menu would offer languages containing nothing at all.
    expect(LANGUAGE_OPTIONS.map((l) => l.code)).toEqual(['en', 'sv', 'fr']);
  });

  test('floors the percentage so 89.9 % can never read as the 90 % that ships', () => {
    expect(byCode('fr').percent).toBe(62);
    expect(byCode('de').percent).toBe(5);
    expect(byCode('en').percent).toBe(100);
  });

  test('carries the beta flag through untouched', () => {
    expect(byCode('fr').beta).toBe(true);
    expect(byCode('en').beta).toBe(false);
    expect(HAS_BETA_LANGUAGES).toBe(true);
  });
});

describe('languageOptionsFor', () => {
  test('shows the usual menu for a language already in it', () => {
    expect(languageOptionsFor('sv')).toEqual(LANGUAGE_OPTIONS);
    expect(languageOptionsFor('fr')).toEqual(LANGUAGE_OPTIONS);
  });

  test('adds back the active language when it is below the floor', () => {
    // A saved preference or a ?lng= preview: the control must show what is
    // actually in effect rather than claiming English.
    expect(languageOptionsFor('de').map((l) => l.code)).toEqual(['en', 'sv', 'de', 'fr']);
    expect(languageOptionsFor('de-AT').map((l) => l.code)).toContain('de');
  });

  test('ignores a language this build does not have', () => {
    expect(languageOptionsFor('ja')).toEqual(LANGUAGE_OPTIONS);
    expect(languageOptionsFor(undefined)).toEqual(LANGUAGE_OPTIONS);
  });
});

describe('findLanguage', () => {
  test('resolves a regional tag to its base language', () => {
    expect(findLanguage('pt-BR')).toBeUndefined();
    expect(findLanguage('sv-SE').code).toBe('sv');
  });
});

describe('isBetaLanguage', () => {
  test.each([
    ['fr', true],
    // Region-suffixed tags must resolve to their base language — a check that
    // only matched 'fr' exactly would treat fr-CA as finished.
    ['fr-CA', true],
    ['de-AT', true],
    ['sv', false],
    ['sv-SE', false],
    ['en', false],
    // Unknown or empty: not beta, because there is nothing to warn about.
    ['xx', false],
    ['', false],
    [undefined, false],
  ])('%s → beta: %s', (code, expected) => {
    expect(isBetaLanguage(code)).toBe(expected);
  });
});
