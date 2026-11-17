// Blog posts in more than one language: the frontend half of the rule in
// backend services/blogLanguage.js. The server answers each post in the
// reader's language when a version exists, else in English; a translation is
// never news, so the unread badge does not count one.

/** The reader's language for the blog: the base code of the language the app shows ('fr-CA' → 'fr'). */
export function readerLanguage(i18n) {
  const raw = (i18n && (i18n.resolvedLanguage || i18n.language)) || 'en';
  const code = String(raw).slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : 'en';
}

/** True for a translation of another post. */
export const isTranslation = (post) => Boolean(post && post.translationOf);

// The languages the editor offers for a post. Wider than the app's own
// languages on purpose: a post can be written for people who search in a
// language the app does not speak yet.
export const BLOG_LANGUAGES = ['en', 'sv', 'fr', 'de', 'nl', 'nb', 'da', 'fi', 'es', 'it'];

/** A language's name in the reader's language ("fr" → "French"), or the code when the browser cannot name it. */
export function languageName(code, uiLanguage) {
  try {
    return new Intl.DisplayNames([uiLanguage || 'en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}
