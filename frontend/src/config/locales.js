import { LOCALES } from 'virtual:locale-coverage';

/**
 * Language menu data, derived from build-time translation coverage.
 *
 * Every language anyone has started is offered — a translator has to be able to
 * run the app in their own work-in-progress, which is where the mistakes a
 * string list hides (clipped buttons, wrong register, an "Other" translated for
 * the wrong context) actually show up. Incomplete ones carry their percentage
 * so the offer is honest rather than a surprise.
 */

// Listed under its own name: someone looking for French scans for "Français",
// not for "French" spelled out in a language they may not read.
const endonym = (code) => {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (!name || name === code) return code.toUpperCase();
    // Several languages lowercase their own name ("français", "svenska");
    // menu entries read better capitalised, per the language's own casing rules.
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code.toUpperCase();
  }
};

export const LANGUAGE_OPTIONS = LOCALES.map((locale) => ({
  ...locale,
  label: endonym(locale.code),
  // Floored, never rounded: 89.6 % must not advertise itself as the 90 % that
  // would have dropped the beta label.
  percent: Math.floor(locale.ratio * 100),
})).sort((a, b) => (a.beta === b.beta ? a.label.localeCompare(b.label) : a.beta ? 1 : -1));

export const HAS_BETA_LANGUAGES = LANGUAGE_OPTIONS.some((l) => l.beta);

export const isBetaLanguage = (code) =>
  LANGUAGE_OPTIONS.find((l) => l.code === String(code || '').split('-')[0])?.beta ?? false;
