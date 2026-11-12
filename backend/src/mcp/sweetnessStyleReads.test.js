/**
 * The MCP wine reads and the sweetness style: sweetness_style beside
 * label_sweetness, decided by the PROJECTION like the label term.
 *
 * WHY THIS TEST EXISTS:
 * The style is the term a wine is known by when its label states none, named
 * by the producer or the trade. A tool that loads it says sweetness_style
 * ({ name, band, scale, regulated, source, source_url }, or null for a wine
 * without one — a row that predates the field included); a tool that does not
 * load it says nothing, so a missing key never reads as "no style". get_wine,
 * search_registry and add_bottle(wine_id) load it. Mocks follow
 * labelSweetnessReads.test.
 */
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn() }));
jest.mock('../services/wineProposalOps', () => ({ pendingForWine: jest.fn(async () => null) }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn() }));
jest.mock('../utils/siteUrl', () => ({ siteBaseUrl: () => 'https://cellarion.app' }));
jest.mock('../services/ownHiddenWines', () => ({
  findOwnHiddenWineIds: jest.fn(async () => []), isOwnHiddenWine: jest.fn(async () => false),
}));
jest.mock('../services/bottleOps', () => ({ addBottle: jest.fn(), updateBottleFields: jest.fn(), markArrived: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn(), replay: jest.fn(async () => null), releaseClaim: jest.fn() }));
jest.mock('./toolUtil', () => ({
  ...jest.requireActual('./toolUtil'),
  resolveCellarAccess: jest.fn(),
  resolveBottleAccess: jest.fn(),
}));

const WineDefinition = require('../models/WineDefinition');
const { findVisibleWine } = require('../services/wineVisibility');
const { addBottle } = require('../services/bottleOps');
const { resolveCellarAccess } = require('./toolUtil');
const { allTools } = require('./registry');
require('./tools/wines');
require('./tools/write');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const oid = (c) => c.repeat(24);
const WINE = oid('a');
const CELLAR = oid('c');
const CTX = { user: { id: oid('1'), roles: ['user'] }, req: { user: { id: oid('1') } } };
const URL = 'https://merchant.example/riesling-kabinett';

const chain = (result) => {
  const c = {};
  for (const m of ['select', 'populate', 'sort', 'limit', 'skip']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => result);
  return c;
};
// A row recorded before the field existed: no sweetnessStyle key at all.
const legacy = (over = {}) => ({ _id: WINE, name: 'Riesling Kabinett', producer: 'Weingut Beispiel', type: 'white', country: { name: 'Germany' }, grapes: [], ...over });
// The style as a read populates it.
const STYLED = { sweetnessStyle: { term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: URL } };
const OUT = { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', source_url: URL };

beforeEach(() => jest.clearAllMocks());

describe('get_wine', () => {
  test('a legacy row reads as no style (null), a styled row carries it with its source and link', async () => {
    WineDefinition.findOne.mockReturnValue(chain(legacy()));
    let body = parse(await tool('get_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data).toMatchObject({ sweetness_style: null, display_name: 'Riesling Kabinett' });

    WineDefinition.findOne.mockReturnValue(chain(legacy(STYLED)));
    body = parse(await tool('get_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data.sweetness_style).toEqual(OUT);
    // Descriptive: the display name stays the label's.
    expect(body.data.display_name).toBe('Riesling Kabinett');
  });

  test('the read selects the field and populates its term', async () => {
    const c = chain(legacy());
    WineDefinition.findOne.mockReturnValue(c);
    await tool('get_wine').handler({ wine_id: WINE }, CTX);
    expect(c.select.mock.calls[0][0].split(/\s+/)).toContain('sweetnessStyle');
    expect(c.populate.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'sweetnessStyle.term' })]));
  });
});

describe('search_registry', () => {
  test('every hit says sweetness_style', async () => {
    WineDefinition.find.mockReturnValue(chain([legacy(), legacy({ _id: oid('b'), ...STYLED })]));
    const body = parse(await tool('search_registry').handler({ query: 'riesling' }, CTX));
    expect(body.data[0]).toMatchObject({ sweetness_style: null });
    expect(body.data[1]).toMatchObject({ sweetness_style: OUT });
  });
});

describe('add_bottle with new_wine', () => {
  test('a wine this call found or created was not read with the style: no sweetness_style key', async () => {
    resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
    addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2019', status: 'active' } });
    const { findOrCreateWine } = require('../services/findOrCreateWine');
    for (const created of [true, false]) {
      findOrCreateWine.mockResolvedValue({ wine: legacy(), created });
      const body = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, new_wine: { name: 'Riesling Kabinett', producer: 'Weingut Beispiel', country: 'Germany', type: 'white' }, confirm_new_wine: true, vintage: '2019' }, CTX));
      expect(body.data.wine).not.toHaveProperty('sweetness_style');
    }
  });
});

describe('add_bottle with wine_id', () => {
  test('the lookup populates the style\'s term and the summary carries it', async () => {
    resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
    addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2019', status: 'active' } });
    findVisibleWine.mockResolvedValue(legacy(STYLED));
    const body = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019' }, CTX));
    expect(body.data.wine).toMatchObject({ sweetness_style: OUT });
    expect(findVisibleWine.mock.calls[0][1].populate).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'sweetnessStyle.term' })]));
  });
});
