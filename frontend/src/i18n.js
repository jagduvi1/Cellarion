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

const baseOf = (lng) => String(lng || '').split('-')[0];

/**
 * First of the browser's preferred languages that we offer as finished.
 *
 * Incomplete ("beta") languages are opt-in only: they are selectable in
 * Settings and load fine once chosen, but nobody is dropped into a
 * half-translated UI merely because their browser is set to that language.
 * Matching is on the base subtag because i18next resolves `fr-CA` to `fr`, so
 * a check against full tags would let region-suffixed values slip through.
 */
export const shippedNavigatorLanguage = (preferred = []) =>
  preferred.map(baseOf).find((code) => SHIPPED_CODES.includes(code));

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
      order: ['localStorage', 'shippedNavigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
    interpolation: {
      escapeValue: false,
    },
  });

async function ensureLocaleLoaded(lng) {
  const base = baseOf(lng);
  const loader = loaderFor(base);
  if (!loader || i18n.hasResourceBundle(base, 'translation')) return;
  try {
    const mod = await loader();
    i18n.addResourceBundle(base, 'translation', mod.default, true, true);
    // Re-trigger languageChanged so already-mounted components re-render
    // with the freshly loaded strings instead of the English fallback.
    if (baseOf(i18n.language) === base) {
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
    document.documentElement.lang = baseOf(lng) || 'en';
  }
}

ensureLocaleLoaded(i18n.language);
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', (lng) => {
  ensureLocaleLoaded(lng);
  syncDocumentLanguage(lng);
});

export default i18n;
