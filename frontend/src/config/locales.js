import { LOCALES, LIST_ABOVE } from 'virtual:locale-coverage';

/**
 * Language menu data, derived from build-time translation coverage.
 *
 * Every language that has enough translated to be worth choosing is offered — a
 * translator has to be able to run the app in their own work-in-progress, which
 * is where the mistakes a string list hides (clipped buttons, wrong register, an
 * "Other" translated for the wrong context) actually show up. Incomplete ones
 * carry their percentage so the offer is honest rather than a surprise.
 */

// Listed under its own name: someone looking for French scans for "Français",
// not for "French" spelled out in a language they may not read.
const endonym = (rawCode) => {
  // Weblate can write either style of regional code; Intl only understands the
  // hyphenated one, and would otherwise throw straight into the fallback.
  const code = rawCode.replace('_', '-');
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

const decorate = (locale) => ({
  ...locale,
  label: endonym(locale.code),
  // Floored, never rounded: 89.6 % must not advertise itself as the 90 % that
  // would have dropped the beta label.
  percent: Math.floor(locale.ratio * 100),
});

const byStatusThenName = (a, b) =>
  a.beta === b.beta ? a.label.localeCompare(b.label) : a.beta ? 1 : -1;

/** Every locale in the build, including ones too empty to offer. */
export const ALL_LANGUAGES = LOCALES.map(decorate).sort(byStatusThenName);

/**
 * The languages worth putting in a menu. English is always present — it is the
 * source language and the fallback, so it can never be "too incomplete".
 */
export const LANGUAGE_OPTIONS = ALL_LANGUAGES.filter(
  (l) => l.code === 'en' || l.ratio >= LIST_ABOVE
);

export const HAS_BETA_LANGUAGES = LANGUAGE_OPTIONS.some((l) => l.beta);

export const baseCode = (code) => String(code || '').split(/[-_]/)[0];

/**
 * The offered language a tag resolves to: exact first, then base subtag, then a
 * regional variant of it. Matching only the base would fail to find a `pt-BR`
 * locale for a saved `pt-BR` preference — the entry exists under its full code.
 */
export const findLanguage = (code) => {
  const tag = String(code || '');
  if (!tag) return undefined;
  return (
    ALL_LANGUAGES.find((l) => l.code === tag) ||
    ALL_LANGUAGES.find((l) => l.code === baseCode(tag)) ||
    ALL_LANGUAGES.find((l) => baseCode(l.code) === baseCode(tag))
  );
};

export const isBetaLanguage = (code) => findLanguage(code)?.beta ?? false;

/**
 * Options to render for a control currently set to `code`.
 *
 * A language below the listing floor still appears when it is the active one —
 * a saved preference, or a `?lng=` preview. Dropping it would leave the control
 * showing English while the interface was in another language, which is worse
 * than an unusual entry in the menu.
 */
export function languageOptionsFor(code) {
  const current = findLanguage(code);
  if (!current || LANGUAGE_OPTIONS.includes(current)) return LANGUAGE_OPTIONS;
  return [...LANGUAGE_OPTIONS, current].sort(byStatusThenName);
}
