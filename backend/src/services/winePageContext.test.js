/**
 * services/winePageContext — what a public wine page shows around the wine.
 *
 * Pins the protection rule: a signed-out reader learns only how many vintages
 * have a reviewed drink window, a member gets the years. Also pins that links
 * point only at taxonomy pages that exist, that related lists never include a
 * canary, and how a curated description becomes one plain sentence.
 */

let mockCount = 5;
let mockProfiles = [];
const mockFindFilters = [];

// A query stand-in: chainable like a Mongoose Query, awaitable to `value`.
function mockQuery(value) {
  const q = {
    select: () => q, populate: () => q, sort: () => q, limit: () => q, maxTimeMS: () => q, lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
}

jest.mock('../models/WineDefinition', () => ({
  countDocuments: jest.fn(() => mockQuery(mockCount)),
  find: jest.fn((filter) => {
    mockFindFilters.push(filter);
    const rows = filter.region
      ? [
        { _id: 's1', name: 'No Shared Grape', producer: 'B', slug: 'b-no-shared', type: 'red', grapes: ['other'] },
        { _id: 's2', name: 'Shares A Grape', producer: 'C', slug: 'c-shares', type: 'red', grapes: ['g1'] },
      ]
      : [{ _id: 'p1', name: 'Sibling', producer: 'A', slug: 'a-sibling', type: 'sparkling', colour: 'rosé', region: { name: 'Somewhere' } }];
    return mockQuery(rows);
  }),
}));
jest.mock('../models/WineVintageProfile', () => ({
  countDocuments: jest.fn(() => mockQuery(mockProfiles.length)),
  find: jest.fn(() => mockQuery(mockProfiles)),
}));

const { buildWinePageContext, firstSentence } = require('./winePageContext');

const WINE = {
  _id: 'w0',
  name: 'Example',
  producer: 'A',
  type: 'red',
  region: { _id: 'r1', name: 'Region', slug: 'region', description: 'Region is **old**. Second sentence.' },
  country: { _id: 'c1', name: 'Country', slug: 'country', description: 'Not used.' },
  grapes: [{ _id: 'g1', name: 'Grape', slug: 'grape', description: '' }],
};
const PROFILE = { vintage: '2019', relative: false, earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2030, lateFrom: 2031, lateUntil: 2033 };

beforeEach(() => {
  mockCount = 5;
  mockProfiles = [];
  mockFindFilters.length = 0;
});

describe('buildWinePageContext', () => {
  test('a signed-out reader gets the count of reviewed vintages, never the years', async () => {
    mockProfiles = [PROFILE];
    const ctx = await buildWinePageContext(WINE, { full: false });
    expect(ctx.reviewedVintages).toBe(1);
    expect(ctx).not.toHaveProperty('drinkWindows');
    expect(JSON.stringify(ctx)).not.toMatch(/2026|2030/);
  });

  test('a member gets the drink windows, newest year first and NV last', async () => {
    const nv = { ...PROFILE, vintage: 'NV', relative: true };
    const older = { ...PROFILE, vintage: '2016' };
    mockProfiles = [nv, older, PROFILE];
    const ctx = await buildWinePageContext(WINE, { full: true });
    expect(ctx.drinkWindows.map((w) => w.vintage)).toEqual(['2019', '2016', 'NV']);
    expect(ctx.reviewedVintages).toBe(3);
  });

  test('the count is exact (not capped by the 30 rows a member gets), and a visitor reads no rows', async () => {
    const WineVintageProfile = require('../models/WineVintageProfile');
    WineVintageProfile.find.mockClear();
    mockProfiles = Array.from({ length: 35 }, (_, i) => ({ ...PROFILE, vintage: String(1980 + i) }));
    const ctx = await buildWinePageContext(WINE, { full: false });
    expect(ctx.reviewedVintages).toBe(35);
    expect(WineVintageProfile.find).not.toHaveBeenCalled();
  });

  test('page checks stop counting at MIN_WINES', async () => {
    const WineDefinition = require('../models/WineDefinition');
    const limits = [];
    WineDefinition.countDocuments.mockImplementationOnce(() => {
      const q = mockQuery(5);
      q.limit = (n) => { limits.push(n); return q; };
      return q;
    });
    await buildWinePageContext(WINE, { full: false });
    expect(limits).toEqual([3]);
  });

  test('links only taxonomy pages that exist; the country carries no excerpt', async () => {
    let ctx = await buildWinePageContext(WINE, { full: false });
    expect(ctx.region).toEqual({ name: 'Region', path: '/regions/region', excerpt: 'Region is old.' });
    expect(ctx.country).toEqual({ name: 'Country', path: '/countries/country', excerpt: null });
    expect(ctx.grapes).toEqual([{ name: 'Grape', path: '/grapes/grape', excerpt: null }]);

    mockCount = 2;
    ctx = await buildWinePageContext(WINE, { full: false });
    expect(ctx.region.path).toBeNull();
  });

  test('related wines: identity only, similar ranked by shared grapes, canaries never listed', async () => {
    const ctx = await buildWinePageContext(WINE, { full: false });
    expect(ctx.sameProducer).toEqual([{ name: 'Sibling', producer: 'A', type: 'sparkling', colour: 'rosé', place: 'Somewhere', path: '/wines/a-sibling' }]);
    expect(ctx.similar.map((w) => w.name)).toEqual(['Shares A Grape', 'No Shared Grape']);
    expect(mockFindFilters.length).toBe(2);
    for (const f of mockFindFilters) {
      expect(f.canary).toEqual({ $ne: true });
      expect(f._id).toEqual({ $ne: 'w0' });
    }
  });
});

describe('a canary page', () => {
  test("lists its producer's other canaries, so an empty list is no tell; real pages never do", async () => {
    await buildWinePageContext({ ...WINE, canary: true }, { full: false });
    const producerFilter = mockFindFilters.find((f) => !f.region);
    expect(producerFilter).not.toHaveProperty('canary');
    expect(producerFilter.nonWine).toEqual({ $ne: true });
  });
});

describe('firstSentence', () => {
  test('a "..." pause in a curated region text is not a sentence end', () => {
    expect(firstSentence('**Provence** ... — a sun-drenched region famous for pale rosé. More.'))
      .toBe('Provence — a sun-drenched region famous for pale rosé.');
  });

  test('a period after an abbreviation is not a sentence end', () => {
    expect(firstSentence('**St. Laurent** is an Austrian red grape. Soft.')).toBe('St. Laurent is an Austrian red grape.');
    expect(firstSentence('Bred by crossing St. Laurent with Blaufränkisch, e.g. in Austria. Juicy.'))
      .toBe('Bred by crossing St. Laurent with Blaufränkisch, e.g. in Austria.');
  });

  test('plain text of the first sentence of the first paragraph', () => {
    expect(firstSentence('**Tuscany** (Toscana) is [famous](https://x). More.\n\nNext paragraph.')).toBe('Tuscany (Toscana) is famous.');
  });

  test('empty or missing → null; a long sentence is cut on a word', () => {
    expect(firstSentence('')).toBeNull();
    expect(firstSentence(null)).toBeNull();
    const long = `${'word '.repeat(80)}end.`;
    const out = firstSentence(long);
    expect(out.length).toBeLessThanOrEqual(220);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});
