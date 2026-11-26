/**
 * The front page's text for the crawler pages (data/landingCopy.json), copied
 * from the app's locale files by scripts/sync-landing-copy.mjs.
 *
 * English is pinned to the app's own text, so the page search engines read in
 * English is the one visitors see. The translations are only checked for being
 * there: Weblate keeps changing them, and the next run of the script brings the
 * current ones in. A key a translation leaves empty reads in English on the
 * page, as it does in the app.
 */

const fs = require('fs');
const path = require('path');
const copy = require('./landingCopy.json');
const { FRONT_PAGE_LANGUAGES } = require('../config/languages');

const LOCALES = path.join(__dirname, '../../../frontend/src/locales');
const landingOf = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, code, 'translation.json'), 'utf8')).landing;

const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (
  v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
));

describe('landingCopy.json', () => {
  test('the English text is the app\'s own landing text (after changing landing.* in the English locale, run node scripts/sync-landing-copy.mjs)', () => {
    expect(copy.en).toEqual(landingOf('en'));
  });

  test('holds English and every front-page language, nothing else', () => {
    expect(Object.keys(copy).filter((k) => k !== '_source').sort()).toEqual(['en', ...FRONT_PAGE_LANGUAGES].sort());
  });

  test.each(FRONT_PAGE_LANGUAGES)('the %s text has a string for every key the English has', (lang) => {
    const own = new Map(flatten(copy[lang]));
    const missing = flatten(copy.en).map(([key]) => key).filter((key) => typeof own.get(key) !== 'string');
    expect(missing).toEqual([]);
  });

  test.each(FRONT_PAGE_LANGUAGES)('the %s text is a translation, not a second copy of the English', (lang) => {
    expect(copy[lang].metaTitle).not.toBe(copy.en.metaTitle);
    expect(copy[lang].heroHeadline).not.toBe(copy.en.heroHeadline);
  });
});
