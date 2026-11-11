/**
 * The crawler-rendered taxonomy pages: GET /api/og/regions/:slug,
 * /countries/:slug, /grapes/:slug and /wine-types/:type.
 *
 * All four are drawn by taxonomyHtml in og/taxonomy.js. A page exists only when at
 * least MIN_WINES public wines use the term (config/taxonomyPages.js), and it
 * lists what the API's first pages list: never a canary, a non-wine or a wine
 * whose identity is pending.
 */

let mockRegion = null;
let mockCountry = null;
let mockGrape = null;
let mockWines = [];

jest.mock('../models/Region', () => {
  const { mockQuery } = require('./og.testKit');
  return { findOne: jest.fn(() => mockQuery(mockRegion)) };
});
jest.mock('../models/Country', () => {
  const { mockQuery } = require('./og.testKit');
  return { findOne: jest.fn(() => mockQuery(mockCountry)) };
});
jest.mock('../models/Grape', () => {
  const { mockQuery } = require('./og.testKit');
  return { findOne: jest.fn(() => mockQuery(mockGrape)) };
});
jest.mock('../models/WineDefinition', () => {
  const { mockQuery } = require('./og.testKit');
  return { find: jest.fn(() => mockQuery(mockWines)) };
});

const Region = require('../models/Region');
const Country = require('../models/Country');
const Grape = require('../models/Grape');
const WineDefinition = require('../models/WineDefinition');
const { MIN_WINES } = require('../config/taxonomyPages');
const {
  SITE, openPages, graphByType, canonical, metaDescription, hreflangs, expectedHreflangs, forSnapshot,
} = require('./og.testKit');

// What every taxonomy page adds to its own wine filter.
const LISTED = { nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true } };
const HOSTILE = 'Cuvée </script><script>alert(1)</script>';

const wines = (n) => Array.from({ length: n }, (_, i) => ({
  _id: `wine${i + 1}`,
  name: `Wine ${i + 1}`,
  producer: i % 2 === 0 ? `Producer ${i + 1}` : '',
  slug: i === 1 ? '' : `wine-${i + 1}`,
}));

const REGION = {
  _id: 'region1',
  name: 'Barolo',
  slug: 'barolo',
  description: 'Barolo lies in the Langhe hills of Piedmont.\nNebbiolo is the only grape.',
  country: { _id: 'country1', name: 'Italy', slug: 'italy' },
  typicalGrapes: [{ _id: 'grape1', name: 'Nebbiolo', slug: 'nebbiolo' }],
};
const COUNTRY = { _id: 'country1', name: 'Italy', slug: 'italy', code: 'IT', description: '' };
const GRAPE = {
  _id: 'grape1',
  name: 'Nebbiolo',
  slug: 'nebbiolo',
  color: 'Red',
  origin: 'Piedmont',
  characteristics: ['high tannin', 'high acidity'],
  agingPotential: 'Ten to thirty years in a good vintage.',
  synonyms: ['Spanna', 'Chiavennasca'],
  description: '',
};

let pages;

beforeAll(async () => { pages = await openPages(require('./og')); });
afterAll(() => pages.close());

beforeEach(() => {
  mockRegion = null;
  mockCountry = null;
  mockGrape = null;
  mockWines = wines(MIN_WINES);
  for (const model of [Region, Country, Grape]) model.findOne.mockClear();
  WineDefinition.find.mockClear();
});

describe('GET /api/og/regions/:slug', () => {
  test('answers 404 for an unknown region, looked up by its lower-cased slug', async () => {
    const res = await pages.get('/regions/BAROLO');

    expect(res.status).toBe(404);
    expect(res.html).toBe('Not found');
    expect(Region.findOne).toHaveBeenCalledWith({ slug: 'barolo' });
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });

  test('answers 404 while fewer than MIN_WINES listed wines use the region', async () => {
    mockRegion = REGION;
    mockWines = wines(MIN_WINES - 1);
    const res = await pages.get('/regions/barolo');

    expect(res.status).toBe(404);
    expect(WineDefinition.find).toHaveBeenCalledWith({ region: 'region1', ...LISTED });
  });

  test('renders the region with its wines, its country in the breadcrumb and three questions', async () => {
    mockRegion = REGION;
    const res = await pages.get('/regions/barolo');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(canonical(res.html)).toBe(`${SITE}/regions/barolo`);
    expect(hreflangs(res.html)).toEqual(expectedHreflangs(`${SITE}/regions/barolo`));
    // The description's line break does not reach the one-line meta description.
    expect(metaDescription(res.html)).toBe('Barolo lies in the Langhe hills of Piedmont. Nebbiolo is the only grape.');
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('a region without description, country or typical grapes gets the stock description and one question', async () => {
    mockRegion = { _id: 'region1', name: 'Barolo', slug: 'barolo' };
    const res = await pages.get('/regions/barolo');
    const graph = graphByType(res.html);

    expect(metaDescription(res.html))
      .toBe('Discover Barolo wines. Browse producers, styles, and cellar-worthy bottles on Cellarion.');
    expect(graph.FAQPage.mainEntity.map((q) => q.name)).toEqual(['What wines are produced in Barolo?']);
    expect(graph.BreadcrumbList.itemListElement.map((b) => b.name)).toEqual(['Cellarion', 'Barolo']);
  });
});

describe('GET /api/og/countries/:slug', () => {
  test('answers 404 for an unknown country and for one with too few listed wines', async () => {
    expect((await pages.get('/countries/Italy')).status).toBe(404);
    expect(Country.findOne).toHaveBeenCalledWith({ slug: 'italy' });

    mockCountry = COUNTRY;
    mockWines = wines(MIN_WINES - 1);
    expect((await pages.get('/countries/italy')).status).toBe(404);
    expect(WineDefinition.find).toHaveBeenCalledWith({ country: 'country1', ...LISTED });
  });

  test('renders the country; past five wines the answer ends "and many more."', async () => {
    mockCountry = COUNTRY;
    mockWines = wines(6);
    const res = await pages.get('/countries/italy');

    expect(res.status).toBe(200);
    expect(canonical(res.html)).toBe(`${SITE}/countries/italy`);
    expect(hreflangs(res.html)).toEqual(expectedHreflangs(`${SITE}/countries/italy`));
    expect(graphByType(res.html).FAQPage.mainEntity[0].acceptedAnswer.text)
      .toBe('Wine 1, Wine 2, Wine 3, Wine 4, Wine 5 and many more.');
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });
});

describe('GET /api/og/grapes/:slug', () => {
  test('answers 404 for an unknown grape and for one with too few listed wines', async () => {
    expect((await pages.get('/grapes/Nebbiolo')).status).toBe(404);
    expect(Grape.findOne).toHaveBeenCalledWith({ slug: 'nebbiolo' });

    mockGrape = GRAPE;
    mockWines = wines(MIN_WINES - 1);
    expect((await pages.get('/grapes/nebbiolo')).status).toBe(404);
    expect(WineDefinition.find).toHaveBeenCalledWith({ grapes: 'grape1', ...LISTED });
  });

  test('renders the grape with a question for each thing the record knows', async () => {
    mockGrape = GRAPE;
    const res = await pages.get('/grapes/nebbiolo');

    expect(res.status).toBe(200);
    expect(canonical(res.html)).toBe(`${SITE}/grapes/nebbiolo`);
    expect(metaDescription(res.html))
      .toBe('Nebbiolo is a red wine grape originating in Piedmont. Discover Nebbiolo wines tracked on Cellarion.');
    expect(graphByType(res.html).FAQPage.mainEntity.map((q) => q.name)).toEqual([
      'What are the characteristics of Nebbiolo?',
      'How long does Nebbiolo age?',
      'What are the synonyms for Nebbiolo?',
      'What wines are made from Nebbiolo?',
    ]);
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('a grape the record knows nothing about still gets the wines question', async () => {
    mockGrape = { _id: 'grape1', name: 'Nebbiolo', slug: 'nebbiolo' };
    const res = await pages.get('/grapes/nebbiolo');

    expect(metaDescription(res.html)).toBe('Nebbiolo is a wine grape. Discover Nebbiolo wines tracked on Cellarion.');
    expect(graphByType(res.html).FAQPage.mainEntity.map((q) => q.name)).toEqual(['What wines are made from Nebbiolo?']);
  });
});

describe('GET /api/og/wine-types/:type', () => {
  test('answers 404 for a type that is not one of the six, without asking the database', async () => {
    const res = await pages.get('/wine-types/orange');

    expect(res.status).toBe(404);
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });

  test('answers 404 while fewer than MIN_WINES listed wines have the type', async () => {
    mockWines = wines(MIN_WINES - 1);
    const res = await pages.get('/wine-types/Red');

    expect(res.status).toBe(404);
    expect(WineDefinition.find).toHaveBeenCalledWith({ type: 'red', ...LISTED });
  });

  test('renders the type page at /wines/type/<type>', async () => {
    const res = await pages.get('/wine-types/sparkling');

    expect(res.status).toBe(200);
    expect(canonical(res.html)).toBe(`${SITE}/wines/type/sparkling`);
    expect(hreflangs(res.html)).toEqual(expectedHreflangs(`${SITE}/wines/type/sparkling`));
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });
});

describe('a wine name on a taxonomy page', () => {
  test('cannot end the JSON-LD block or add markup to the page', async () => {
    mockCountry = COUNTRY;
    mockWines = [{ _id: 'w1', name: HOSTILE, producer: '<b>Bold</b>', slug: 'hostile' }, ...wines(MIN_WINES)];
    const res = await pages.get('/countries/italy');

    expect(graphByType(res.html).ItemList.itemListElement[0].name).toBe(HOSTILE);
    expect(res.html).not.toContain('<script>alert(1)');
    expect(res.html).not.toContain('<b>Bold</b>');
    expect(res.html).toContain('Cuvée &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; — &lt;b&gt;Bold&lt;/b&gt;');
  });
});
