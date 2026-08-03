import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { LOCALE_CODES, SHIPPED_CODES } from 'virtual:locale-coverage';

// English is the fallback language and stays statically bundled so first
// paint never waits on a locale fetch. Other locales are loaded on demand —
// bundling them all puts every language in the entry chunk every visitor
// downloads (~100 kB raw per locale), and that cost grows with every
// community translation.
import en from './locales/en/translation.json';

// Discovered, not enumerated: a language becomes loadable the moment Weblate's
// PR adds its folder, with no code change to remember.
const LOADERS = import.meta.glob('./locales/*/translation.json');
const loaderFor = (code) => LOADERS[`./locales/${code}/translation.json`];

const baseOf = (lng) => String(lng || '').split(/[-_]/)[0];

/**
 * The locale directory that should answer for a language tag.
 *
 * Exact match first, base subtag second, and a regional directory as a last
 * resort. Reducing straight to the base would strand a `pt-BR` (or `zh-Hans`)
 * directory: the loader key is the directory name, so `pt` would find nothing,
 * the bundle would never register, and the interface would sit in English with
 * nothing logged. i18next has the matching quirk — with `pt-BR` in
 * supportedLngs it drops `pt` from the resolution chain entirely — so the
 * bundle has to be registered under the code that actually matched.
 */
export const resolveLocaleCode = (lng, codes = Object.keys(LOADERS).map((p) => p.split('/')[2])) => {
  const tag = String(lng || '');
  if (!tag) return undefined;
  return (
    codes.find((code) => code === tag) ||
    codes.find((code) => code === baseOf(tag)) ||
    codes.find((code) => baseOf(code) === baseOf(tag))
  );
};

/**
 * First of the browser's preferred languages that we offer as finished.
 *
 * Incomplete ("beta") languages are opt-in only: they are selectable in
 * Settings and load fine once chosen, but nobody is dropped into a
 * half-translated UI merely because their browser is set to that language.
 * Comparison tolerates region subtags on either side — a `fr-CA` browser must
 * not slip past a gate listing `fr`, and a `pt-PT` browser should still be
 * offered a shipped `pt-BR` rather than English.
 */
export const shippedNavigatorLanguage = (preferred = [], codes = SHIPPED_CODES) =>
  preferred.map((tag) => resolveLocaleCode(tag, codes)).find(Boolean);

// The querystring key i18next detects below. Exported because one other place
// has to recognise a preview — AuthContext, which must not overwrite it with
// the stored account preference — and a second hard-coded 'lng' there would be
// free to drift out of step with this one.
export const LANGUAGE_QUERY_PARAM = 'lng';

/**
 * Whether this page load carries an explicit `?lng=` preview.
 *
 * Deliberately reads the live URL rather than a router value: the preview is a
 * property of how the document was opened, and it has to be answerable during
 * session restore, before any router exists.
 */
export const hasLanguagePreview = (search) =>
  new URLSearchParams(
    search ?? (typeof window === 'undefined' ? '' : window.location.search)
  ).has(LANGUAGE_QUERY_PARAM);

const detector = new LanguageDetector();

detector.addDetector({
  name: 'shippedNavigator',
  lookup: () => {
    if (typeof navigator === 'undefined') return undefined;
    return shippedNavigatorLanguage(
      navigator.languages?.length ? navigator.languages : [navigator.language]
    );
  },
});

i18n
  .use(detector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    // Languages outside `resources` are loaded via LOADERS below —
    // don't treat their absence at init as "unsupported".
    partialBundledLanguages: true,
    fallbackLng: 'en',
    // Every locale present in the repo, beta ones included: an explicit choice
    // (Settings, or a saved account preference) is always honoured.
    supportedLngs: LOCALE_CODES,
    detection: {
      // `?lng=fr` first: it is how a translator previews a language that is not
      // in the menu yet (see TRANSLATING.md). Explicit, so it may select an
      // incomplete language — unlike the navigator lookup, which may not.
      order: ['querystring', 'localStorage', 'shippedNavigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
      lookupQuerystring: LANGUAGE_QUERY_PARAM,
    },
    interpolation: {
      escapeValue: false,
    },
  });

async function ensureLocaleLoaded(lng) {
  const code = resolveLocaleCode(lng);
  const loader = code && loaderFor(code);
  if (!loader || i18n.hasResourceBundle(code, 'translation')) return;
  try {
    const mod = await loader();
    i18n.addResourceBundle(code, 'translation', mod.default, true, true);
    // Re-trigger languageChanged so already-mounted components re-render
    // with the freshly loaded strings instead of the English fallback.
    if (resolveLocaleCode(i18n.language) === code) {
      i18n.changeLanguage(i18n.language);
    }
  } catch {
    // Loading failed (offline?) — English fallback keeps the app usable.
  }
}

// index.html ships `<html lang="en">` and only the landing page ever overrode
// it, so every other route stayed declared English whatever the user picked —
// wrong for screen readers, hyphenation and translation tooling alike. Keeping
// it in step here fixes all routes at once, for every locale.
function syncDocumentLanguage(lng) {
  if (typeof document !== 'undefined') {
    // The full tag, not the base: pt-BR is more useful to a screen reader than
    // pt. Underscores (Weblate's other code style) are normalised because
    // `lang="pt_BR"` is not a valid BCP-47 tag.
    document.documentElement.lang = String(lng || 'en').replace('_', '-') || 'en';
  }
}

ensureLocaleLoaded(i18n.language);
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', (lng) => {
  ensureLocaleLoaded(lng);
  syncDocumentLanguage(lng);
});

export default i18n;
