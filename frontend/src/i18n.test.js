/**
 * Language selection rules.
 *
 * The promise made to readers is narrow and worth pinning: an unfinished
 * translation is something you can choose, never something you are given. A
 * regression here doesn't throw — it quietly serves a half-English UI to people
 * who never asked for one, which is exactly the failure that kept community
 * languages unreleasable in the first place.
 */

vi.mock('virtual:locale-coverage', () => ({
  BETA_BELOW: 0.9,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false },
    { code: 'fr', translated: 62, total: 100, ratio: 0.62, beta: true },
  ],
  LOCALE_CODES: ['en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

const { default: i18n, shippedNavigatorLanguage } = await import('./i18n');

describe('automatic browser-language detection', () => {
  test('picks a finished language', () => {
    expect(shippedNavigatorLanguage(['sv-SE', 'sv'])).toBe('sv');
    expect(shippedNavigatorLanguage(['en-GB'])).toBe('en');
  });

  test('never picks an unfinished one', () => {
    expect(shippedNavigatorLanguage(['fr-FR', 'fr'])).toBeUndefined();
  });

  test('skips past an unfinished language to a finished one further down the list', () => {
    // A French-first browser that also accepts Swedish gets Swedish, not a
    // 62 %-translated French UI.
    expect(shippedNavigatorLanguage(['fr-FR', 'sv-SE', 'en-US'])).toBe('sv');
  });

  test('matches on the base subtag, so a region-suffixed tag cannot slip through', () => {
    // i18next resolves fr-CA to fr; a gate comparing whole tags would not.
    expect(shippedNavigatorLanguage(['fr-CA'])).toBeUndefined();
    expect(shippedNavigatorLanguage(['sv-FI'])).toBe('sv');
  });

  test('gives no answer for languages nobody has translated, leaving the fallback to i18next', () => {
    expect(shippedNavigatorLanguage(['ja-JP', 'ko'])).toBeUndefined();
    expect(shippedNavigatorLanguage([])).toBeUndefined();
  });
});

describe('i18next wiring', () => {
  test('consults our gated detector instead of the raw navigator one', () => {
    // If 'navigator' ever reappears in this list, beta languages become
    // automatic again and every test above stops meaning anything.
    expect(i18n.options.detection.order).toEqual(['localStorage', 'shippedNavigator']);
  });

  test('supports every locale in the build, beta included', () => {
    // Beta languages must remain selectable — the gate belongs to detection,
    // not to what i18next will accept.
    expect(i18n.options.supportedLngs).toEqual(expect.arrayContaining(['en', 'sv', 'fr']));
  });

  test('falls back to English so untranslated keys degrade rather than blank', () => {
    expect(i18n.options.fallbackLng).toContain('en');
  });
});

describe('explicit choices', () => {
  test('an unfinished language can be chosen and stays chosen', async () => {
    await i18n.changeLanguage('fr');
    expect(i18n.language).toBe('fr');
  });

  test('the document declares the active language, not the shell default', async () => {
    await i18n.changeLanguage('fr');
    expect(document.documentElement.lang).toBe('fr');
    await i18n.changeLanguage('sv');
    expect(document.documentElement.lang).toBe('sv');
  });
});
