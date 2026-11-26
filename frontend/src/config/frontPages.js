// The front page has an address of its own in these languages, besides English
// at "/": /fr and /de. Twin of FRONT_PAGE_LANGUAGES in
// backend/src/config/languages.js (the crawler pages and the sitemap) and of
// the /(fr|de) location in nginx.conf; frontPages.test.js keeps the three equal.
export const FRONT_PAGE_LANGUAGES = ['fr', 'de'];

export const frontPagePath = (lang) => (lang && lang !== 'en' ? `/${lang}` : '/');

/** The front page's language versions, for SEOHead's hreflang: English is x-default. */
export const FRONT_PAGE_ALTERNATES = [
  { lang: 'en', path: '/' },
  ...FRONT_PAGE_LANGUAGES.map((lang) => ({ lang, path: frontPagePath(lang) })),
];

/**
 * The language to switch the app to on the front page at `pageLanguage`, or
 * null to leave it as it is.
 *
 * A visitor who is not signed in gets the page's language, for this visit only
 * (nothing is remembered), so signing up from /fr carries on in French and the
 * new account keeps it. A signed-in member's own language wins, and nothing is
 * switched while the session is still being restored, so a member never sees
 * the page flash into another language first.
 */
export function frontPageLanguageSwitch({ pageLanguage, shownLanguage, signedIn, restoring }) {
  if (!pageLanguage || pageLanguage === 'en' || signedIn || restoring) return null;
  return shownLanguage === pageLanguage ? null : pageLanguage;
}
