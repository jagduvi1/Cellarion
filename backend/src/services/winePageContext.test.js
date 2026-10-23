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

jest.mock('../models/WineDefinition', () => ({
  countDocuments: jest.fn(() => Promise.resolve(mockCount)),
  find: jest.fn((filter) => {
    mockFindFilters.push(filter);
    const rows = filter.region
      ? [
        { _id: 's1', name: 'No Shared Grape', producer: 'B', slug: 'b-no-shared', type: 'red', grapes: ['other'] },
        { _id: 's2', name: 'Shares A Grape', producer: 'C', slug: 'c-shares', type: 'red', grapes: ['g1'] },
      ]
      : [{ _id: 'p1', name: 'Sibling', producer: 'A', slug: 'a-sibling', type: 'white', region: { name: 'Somewhere' } }];
    const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(rows) };
    return q;
  }),
}));
jest.mock('../models/WineVintageProfile', () => ({
  find: jest.fn(() => {
    const q = { select: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(mockProfiles) };
    return q;
  }),
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

  test('a member gets the drink windows', async () => {
    mockProfiles = [PROFILE];
    const ctx = await buildWinePageContext(WINE, { full: true });
    expect(ctx.drinkWindows).toEqual([PROFILE]);
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
    expect(ctx.sameProducer).toEqual([{ name: 'Sibling', producer: 'A', type: 'white', place: 'Somewhere', path: '/wines/a-sibling' }]);
    expect(ctx.similar.map((w) => w.name)).toEqual(['Shares A Grape', 'No Shared Grape']);
    expect(mockFindFilters.length).toBe(2);
    for (const f of mockFindFilters) {
      expect(f.canary).toEqual({ $ne: true });
      expect(f._id).toEqual({ $ne: 'w0' });
    }
  });
});

describe('firstSentence', () => {
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
