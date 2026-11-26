/**
 * Languages the public site is advertised in.
 *
 * The app's own language list is derived automatically from the locale files in
 * the frontend (one directory per language, delivered by Weblate) together with
 * their completeness — see frontend/src/locales/coverage.js. The backend image
 * doesn't ship those files, so the crawler-rendered pages in routes/og/ need
 * their own copy of the answer.
 *
 * Keep this in step with the languages the app offers as finished, i.e. the
 * ones past the beta threshold. A language graduating out of beta is already a
 * deliberate, announced step (see TRANSLATING.md) — this line is part of it.
 * Beta languages are deliberately absent: pointing a crawler at a
 * half-translated page is worse than not claiming the language at all.
 * frontend/src/config/frontPages.test.js fails when a language listed here is
 * not finished in the app.
 */
const CRAWLER_LANGUAGES = ['en', 'de', 'fr', 'nb', 'sv'];

/**
 * Languages the front page has an address of its own in, besides English at
 * "/": /fr and /de, each answered in that language to visitors and crawlers
 * alike. Read by the crawler page (routes/og/site.js), the sitemap and
 * scripts/sync-landing-copy.mjs. Twin of FRONT_PAGE_LANGUAGES in
 * frontend/src/config/frontPages.js and of the /(fr|de) location in
 * frontend/nginx.conf; frontPages.test.js keeps the three equal.
 */
const FRONT_PAGE_LANGUAGES = ['fr', 'de'];

module.exports = { CRAWLER_LANGUAGES, FRONT_PAGE_LANGUAGES };
