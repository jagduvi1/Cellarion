/**
 * GET /api/og/home — the landing page crawlers get instead of the SPA shell.
 *
 * The page is built from the LANDING copy in og/site.js and reads nothing from the
 * database. Pins what a search engine judges it by: the canonical address, the
 * language alternates, the four JSON-LD entities, and that the FAQ and the
 * feature list in the structured data are the ones a reader sees on the page.
 */

const {
  SITE, openPages, escHtml, graphByType, canonical, hreflangs, expectedHreflangs,
} = require('./og.testKit');

let pages;
let home;

beforeAll(async () => {
  pages = await openPages(require('./og'));
  home = await pages.get('/home');
});

afterAll(() => pages.close());

describe('GET /api/og/home', () => {
  test('answers a cacheable HTML page whose canonical address is the site root', () => {
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(home.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(canonical(home.html)).toBe(`${SITE}/`);
  });

  test('offers the page in every crawler language and as x-default', () => {
    expect(hreflangs(home.html)).toEqual(expectedHreflangs(`${SITE}/`));
  });

  test('describes the site, the organisation, the app and the FAQ as JSON-LD', () => {
    const graph = graphByType(home.html);
    expect(Object.keys(graph)).toEqual(['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']);
    expect(graph.WebSite.url).toBe(SITE);
    expect(graph.Organization.logo).toBe(`${SITE}/cellarion-logo.jpg`);
    expect(graph.SoftwareApplication.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
  });

  test('shows every question and answer of the FAQ JSON-LD on the page, word for word', () => {
    const questions = graphByType(home.html).FAQPage.mainEntity;
    expect(questions.length).toBeGreaterThanOrEqual(2);
    for (const { name, acceptedAnswer } of questions) {
      expect(home.html).toContain(`<h3>${escHtml(name)}</h3><p>${escHtml(acceptedAnswer.text)}</p>`);
    }
  });

  test('has a heading for every feature the app entity lists', () => {
    const features = graphByType(home.html).SoftwareApplication.featureList;
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(home.html).toContain(`<h3>${escHtml(feature)}</h3>`);
    }
  });
});
