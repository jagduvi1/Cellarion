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
  LIST_ABOVE: 0.1,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false },
    { code: 'fr', translated: 62, total: 100, ratio: 0.62, beta: true },
  ],
  LOCALE_CODES: ['en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

const { default: i18n, shippedNavigatorLanguage, resolveLocaleCode, hasLanguagePreview } =
  await import('./i18n');

describe('resolving a language tag to a locale directory', () => {
  // Weblate names the directory after the language code, which for a regional
  // variant is 'pt-BR' (or 'pt_BR'). Reducing to the base subtag would look for
  // a 'pt' directory that does not exist, register nothing, and leave the
  // interface in English with nothing logged anywhere.
  const dirs = ['en', 'fr', 'pt-BR', 'sv'];

  test('prefers an exact directory match', () => {
    expect(resolveLocaleCode('pt-BR', dirs)).toBe('pt-BR');
    expect(resolveLocaleCode('sv', dirs)).toBe('sv');
  });

  test('falls back to the base subtag when the region has no directory', () => {
    expect(resolveLocaleCode('sv-SE', dirs)).toBe('sv');
    expect(resolveLocaleCode('fr-CA', dirs)).toBe('fr');
  });

  test('finds a regional directory for a bare base tag', () => {
    // A preference saved as 'pt' should still reach the only Portuguese we have.
    expect(resolveLocaleCode('pt', dirs)).toBe('pt-BR');
  });

  test('tolerates the underscore code style Weblate can also write', () => {
    expect(resolveLocaleCode('pt_BR', ['en', 'pt_BR'])).toBe('pt_BR');
    expect(resolveLocaleCode('pt-BR', ['en', 'pt_BR'])).toBe('pt_BR');
  });

  test('gives nothing for a language this build does not have', () => {
    expect(resolveLocaleCode('ja', dirs)).toBeUndefined();
    expect(resolveLocaleCode('', dirs)).toBeUndefined();
    expect(resolveLocaleCode(undefined, dirs)).toBeUndefined();
  });
});

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

  test('offers a shipped regional language to a browser asking for a sibling region', () => {
    // pt-BR is finished; a pt-PT browser is better served by it than by English.
    expect(shippedNavigatorLanguage(['pt-PT'], ['en', 'pt-BR'])).toBe('pt-BR');
    // …but only when that language actually shipped: a beta pt-BR is not in the
    // list it is given, so the answer stays English.
    expect(shippedNavigatorLanguage(['pt-PT'], ['en', 'sv'])).toBeUndefined();
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
    expect(i18n.options.detection.order).toEqual(['querystring', 'localStorage', 'shippedNavigator']);
    expect(i18n.options.detection.order).not.toContain('navigator');
  });

  test('lets ?lng= preview a language, ahead of any stored choice', () => {
    // How a translator sees work-in-progress that is not in the menu yet. It
    // ranks above localStorage so the preview wins for that visit.
    expect(i18n.options.detection.order.indexOf('querystring')).toBe(0);
    expect(i18n.options.detection.lookupQuerystring).toBe('lng');
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

/**
 * `?lng=` is the preview a translator works from, and AuthContext consults this
 * to decide whether to leave it alone. The regression it guards against is
 * silent: a signed-in translator opens ?lng=fr, sees French for one frame, and
 * concludes the feature is broken — which is exactly the report that prompted
 * these tests.
 */
describe('detecting a ?lng= preview', () => {
  test('recognises the preview parameter, wherever it sits in the query', () => {
    expect(hasLanguagePreview('?lng=fr')).toBe(true);
    expect(hasLanguagePreview('?sort=name&lng=et')).toBe(true);
  });

  test('an empty value still counts — `?lng=` is an explicit act', () => {
    // i18next resolves the empty value to nothing and moves down its detection
    // order; what matters here is that a stored preference does not overwrite
    // whatever it settled on.
    expect(hasLanguagePreview('?lng=')).toBe(true);
  });

  test('is false for ordinary URLs, so saved preferences still apply', () => {
    expect(hasLanguagePreview('')).toBe(false);
    expect(hasLanguagePreview('?sort=name')).toBe(false);
  });

  test('does not match a parameter that merely contains lng', () => {
    expect(hasLanguagePreview('?lngx=fr')).toBe(false);
    expect(hasLanguagePreview('?mylng=fr')).toBe(false);
  });
});
