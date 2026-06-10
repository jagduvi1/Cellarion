import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English is the fallback language and stays statically bundled so first
// paint never waits on a locale fetch. Other locales are loaded on demand —
// bundling them all puts every language in the entry chunk every visitor
// downloads (~100 kB raw per locale).
import en from './locales/en/translation.json';

const DYNAMIC_LOCALES = {
  sv: () => import('./locales/sv/translation.json'),
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    // Languages outside `resources` are loaded via DYNAMIC_LOCALES below —
    // don't treat their absence at init as "unsupported".
    partialBundledLanguages: true,
    fallbackLng: 'en',
    supportedLngs: ['en', 'sv'],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
    interpolation: {
      escapeValue: false,
    },
  });

async function ensureLocaleLoaded(lng) {
  const base = String(lng || '').split('-')[0];
  const loader = DYNAMIC_LOCALES[base];
  if (!loader || i18n.hasResourceBundle(base, 'translation')) return;
  try {
    const mod = await loader();
    i18n.addResourceBundle(base, 'translation', mod.default, true, true);
    // Re-trigger languageChanged so already-mounted components re-render
    // with the freshly loaded strings instead of the English fallback.
    if (String(i18n.language || '').split('-')[0] === base) {
      i18n.changeLanguage(i18n.language);
    }
  } catch {
    // Loading failed (offline?) — English fallback keeps the app usable.
  }
}

ensureLocaleLoaded(i18n.language);
i18n.on('languageChanged', ensureLocaleLoaded);

export default i18n;
