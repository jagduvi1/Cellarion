/**
 * Languages the public site is advertised in.
 *
 * The app's own language list is derived automatically from the locale files in
 * the frontend (one directory per language, delivered by Weblate) together with
 * their completeness — see frontend/src/locales/coverage.js. The backend image
 * doesn't ship those files, so the crawler-rendered pages in routes/og.js need
 * their own copy of the answer.
 *
 * Keep this in step with the languages the app offers as finished, i.e. the
 * ones past the beta threshold. A language graduating out of beta is already a
 * deliberate, announced step (see TRANSLATING.md) — this line is part of it.
 * Beta languages are deliberately absent: pointing a crawler at a
 * half-translated page is worse than not claiming the language at all.
 */
const CRAWLER_LANGUAGES = ['en', 'sv'];

module.exports = { CRAWLER_LANGUAGES };
