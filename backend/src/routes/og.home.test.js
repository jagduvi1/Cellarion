/**
 * GET /api/og/home and /api/og/home/:lang — the front page crawlers get
 * instead of the SPA shell, in English at "/" and in each front-page language
 * at its own address (/fr, /de).
 *
 * The page is built from data/landingCopy.json (the app's landing text) and
 * reads nothing from the database. Pins what a search engine judges it by: the
 * canonical address, the language alternates, the language the page declares
 * and is written in, the four JSON-LD entities, and that the FAQ and the
 * feature list in the structured data are the ones a reader sees on the page.
 */

const { SITE, openPages, escHtml, graphByType, canonical, hreflangs } = require('./og.testKit');
const { FRONT_PAGE_LANGUAGES } = require('../config/languages');
const copy = require('../data/landingCopy.json');

const LANGUAGES = ['en', ...FRONT_PAGE_LANGUAGES];
const addressOf = (lang) => (lang === 'en' ? `${SITE}/` : `${SITE}/${lang}`);
const routeOf = (lang) => (lang === 'en' ? '/home' : `/home/${lang}`);

let pages;
const page = {};

beforeAll(async () => {
  pages = await openPages(require('./og'));
  for (const lang of LANGUAGES) page[lang] = await pages.get(routeOf(lang));
}, 30000); // the app is loaded and three pages are asked for once, for every test below

afterAll(() => pages.close());

test('the front page has an address of its own in French and German', () => {
  expect(FRONT_PAGE_LANGUAGES).toEqual(expect.arrayContaining(['fr', 'de']));
});

describe.each(LANGUAGES)('the front page in %s', (lang) => {
  const html = () => page[lang].html;

  test('answers a cacheable HTML page whose canonical address is its own', () => {
    expect(page[lang].status).toBe(200);
    expect(page[lang].headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page[lang].headers.get('cache-control')).toBe('public, max-age=3600');
    expect(canonical(html())).toBe(addressOf(lang));
  });

  test('links every language version at its own address, English as x-default', () => {
    expect(hreflangs(html())).toEqual([
      ...LANGUAGES.map((l) => [l, addressOf(l)]),
      ['x-default', `${SITE}/`],
    ]);
  });

  test('declares its language and is written in it', () => {
    expect(html()).toContain(`<html lang="${lang}">`);
    expect(html()).toContain(`<title>${escHtml(copy[lang].metaTitle)}</title>`);
    expect(html()).toContain(`<h1>${escHtml(`${copy[lang].heroHeadline} ${copy[lang].heroAccent}`)}</h1>`);
    expect(html()).toContain(`<h2>${escHtml(copy[lang].faqTitle)}</h2>`);
  });

  test('describes the site, the organisation, the app and the FAQ as JSON-LD', () => {
    const graph = graphByType(html());
    expect(Object.keys(graph)).toEqual(['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']);
    expect(graph.WebSite.url).toBe(SITE);
    expect(graph.Organization.logo).toBe(`${SITE}/cellarion-logo.jpg`);
    expect(graph.SoftwareApplication.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    expect(graph.SoftwareApplication.description).toBe(copy[lang].metaDescription);
    expect(graph.FAQPage['@id']).toBe(`${addressOf(lang)}#faq`);
    expect(graph.FAQPage.inLanguage).toBe(lang);
  });

  test('shows every question and answer of the FAQ JSON-LD on the page, word for word', () => {
    const questions = graphByType(html()).FAQPage.mainEntity;
    expect(questions.map((q) => q.name)).toEqual(
      Object.keys(copy.en.faq).filter((k) => /^q\d+$/.test(k)).map((k) => copy[lang].faq[k]),
    );
    for (const { name, acceptedAnswer } of questions) {
      expect(html()).toContain(`<h3>${escHtml(name)}</h3><p>${escHtml(acceptedAnswer.text)}</p>`);
    }
  });

  test('has a heading for every feature the app entity lists', () => {
    const features = graphByType(html()).SoftwareApplication.featureList;
    expect(features).toHaveLength(8);
    expect(features[0]).toBe(copy[lang].featureBottleTitle);
    for (const feature of features) {
      expect(html()).toContain(`<h3>${escHtml(feature)}</h3>`);
    }
  });
});

describe('GET /api/og/home/:lang', () => {
  test.each(['en', 'xx', 'nl', 'FR'])('/home/%s is a 404: only the front-page languages have a second address', async (lang) => {
    expect((await pages.get(`/home/${lang}`)).status).toBe(404);
  });
});
