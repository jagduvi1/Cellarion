// Blog posts in more than one language: the frontend half of the rule in
// backend services/blogLanguage.js. The blog lists the originals, the same for
// every reader; a translation is reached from its original's page, and it is
// never news, so the unread badge does not count one.

/** True for a translation of another post. */
export const isTranslation = (post) => Boolean(post && post.translationOf);

// The languages the editor offers for a post. Wider than the app's own
// languages on purpose: a post can be translated for people who search in a
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

/**
 * A language's name in itself, capitalised ("sv" → "Svenska"): how a link to
 * a translation is labelled, so a reader finds their own language whatever
 * language the page is in.
 */
export function nativeLanguageName(code) {
  const name = languageName(code, code);
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}
