/**
 * The language menu is assembled from build-time coverage, so these assertions
 * use a synthetic set: the real build only has finished languages, and the
 * interesting behaviour is what happens to an unfinished one.
 */

vi.mock('virtual:locale-coverage', () => ({
  BETA_BELOW: 0.9,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false },
    // 0.629 — deliberately not a round number: the label must round DOWN.
    { code: 'fr', translated: 629, total: 1000, ratio: 0.629, beta: true },
    { code: 'de', translated: 5, total: 100, ratio: 0.05, beta: true },
  ],
  LOCALE_CODES: ['de', 'en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

const { LANGUAGE_OPTIONS, HAS_BETA_LANGUAGES, isBetaLanguage } = await import('./locales');

describe('LANGUAGE_OPTIONS', () => {
  const byCode = (code) => LANGUAGE_OPTIONS.find((l) => l.code === code);

  test('labels each language in its own language, capitalised', () => {
    expect(byCode('en').label).toBe('English');
    expect(byCode('sv').label).toBe('Svenska');
    expect(byCode('fr').label).toBe('Français');
    expect(byCode('de').label).toBe('Deutsch');
  });

  test('finished languages come first, each group alphabetical', () => {
    expect(LANGUAGE_OPTIONS.map((l) => l.code)).toEqual(['en', 'sv', 'de', 'fr']);
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
