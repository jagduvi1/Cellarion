// @vitest-environment node
/**
 * The front page's language addresses (/fr, /de) are named in three places:
 * this config (the app's routes and hreflang), the backend's (the crawler
 * pages and the sitemap) and nginx.conf (which sends crawlers there). These
 * tests keep the three equal, keep both language lists to languages the app
 * offers as finished, and pin who gets the page's language.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SHIPPED_CODES } from 'virtual:locale-coverage';
import {
  FRONT_PAGE_LANGUAGES, FRONT_PAGE_ALTERNATES, frontPagePath, frontPageLanguageSwitch,
} from './frontPages';

const repo = path.resolve(__dirname, '../../..');
const backend = createRequire(import.meta.url)(path.join(repo, 'backend/src/config/languages.js'));
const nginx = fs.readFileSync(path.join(repo, 'frontend/nginx.conf'), 'utf8');

describe('the front-page languages', () => {
  test('are the backend\'s, for the crawler pages and the sitemap', () => {
    expect(FRONT_PAGE_LANGUAGES).toEqual(backend.FRONT_PAGE_LANGUAGES);
  });

  test('are the ones nginx sends crawlers to the server-rendered page for', () => {
    const location = /location ~ "\^\/\(([a-z|]+)\)\$" \{\s*error_page 418 = @front_page_og;/.exec(nginx);
    expect(location).not.toBeNull();
    expect(location[1].split('|')).toEqual(FRONT_PAGE_LANGUAGES);
  });

  test('are all finished languages of the app, so no half-translated page is offered', () => {
    for (const lang of FRONT_PAGE_LANGUAGES) expect(SHIPPED_CODES).toContain(lang);
  });

  test('every language the crawler pages advertise is a finished language of the app', () => {
    for (const lang of backend.CRAWLER_LANGUAGES) expect(SHIPPED_CODES).toContain(lang);
  });

  test('each has its own address, and English is the front page itself', () => {
    expect(frontPagePath('en')).toBe('/');
    expect(frontPagePath('fr')).toBe('/fr');
    expect(FRONT_PAGE_ALTERNATES).toEqual([
      { lang: 'en', path: '/' },
      ...FRONT_PAGE_LANGUAGES.map((lang) => ({ lang, path: `/${lang}` })),
    ]);
  });
});

describe('frontPageLanguageSwitch', () => {
  const visit = { pageLanguage: 'fr', shownLanguage: 'en', signedIn: false, restoring: false };

  test('a visitor who is not signed in gets the page\'s language', () => {
    expect(frontPageLanguageSwitch(visit)).toBe('fr');
  });

  test('nothing changes when the page is already in its language', () => {
    expect(frontPageLanguageSwitch({ ...visit, shownLanguage: 'fr' })).toBeNull();
  });

  test('a signed-in member keeps their own language', () => {
    expect(frontPageLanguageSwitch({ ...visit, signedIn: true })).toBeNull();
  });

  test('nothing is switched while the session is being restored', () => {
    expect(frontPageLanguageSwitch({ ...visit, restoring: true })).toBeNull();
  });

  test('the English front page never switches the language: the visitor\'s own decides there', () => {
    expect(frontPageLanguageSwitch({ ...visit, pageLanguage: 'en', shownLanguage: 'sv' })).toBeNull();
  });
});
