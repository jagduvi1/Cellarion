/**
 * The MCP wine reads and the label sweetness term (GitHub discussion #1754):
 * the PROJECTION decides what is said.
 *
 * WHY THIS TEST EXISTS:
 * Thousands of registry rows predate the field, and a lean read of one of them
 * has no `labelSweetness` key at all. A tool that selected and populated the
 * field must still answer for such a row — `label_sweetness: null` and the
 * display name — exactly as for a row that states no term; otherwise a curator
 * cannot tell "legacy row" from "not loaded". get_wine, search_registry and
 * add_bottle(wine_id) all load the field. Mocks follow
 * getWine.pendingIdentity.test and addBottleOnOrder.test.
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

const chain = (result) => {
  const c = {};
  for (const m of ['select', 'populate', 'sort', 'limit', 'skip']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => result);
  return c;
};
// A row recorded before the field existed: no labelSweetness key at all.
const legacy = (over = {}) => ({ _id: WINE, name: 'Riesling Spätlese', producer: 'Weingut Keller', type: 'white', country: { name: 'Germany' }, grapes: [], ...over });
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };

beforeEach(() => jest.clearAllMocks());

describe('get_wine', () => {
  test('a legacy row reads as no term: label_sweetness null and the display name — never a missing key', async () => {
    WineDefinition.findOne.mockReturnValue(chain(legacy()));
    const body = parse(await tool('get_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data).toMatchObject({ name: 'Riesling Spätlese', label_sweetness: null, display_name: 'Riesling Spätlese' });
  });

  test('a row recording a term carries it, as { name, band, scale, regulated }, and the display name reads like the label', async () => {
    WineDefinition.findOne.mockReturnValue(chain(legacy({ labelSweetness: TROCKEN })));
    const body = parse(await tool('get_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data.label_sweetness).toEqual(TROCKEN);
    expect(body.data.display_name).toBe('Riesling Spätlese trocken');
  });

  test('the read selects and populates the term', async () => {
    const c = chain(legacy());
    WineDefinition.findOne.mockReturnValue(c);
    await tool('get_wine').handler({ wine_id: WINE }, CTX);
    expect(c.select.mock.calls[0][0].split(/\s+/)).toContain('labelSweetness');
    expect(c.populate.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'labelSweetness' })]));
  });
});

describe('search_registry', () => {
  test('every hit says label_sweetness (null for a legacy row) and display_name', async () => {
    WineDefinition.find.mockReturnValue(chain([legacy(), legacy({ _id: oid('b'), name: 'Riesling Kabinett', labelSweetness: TROCKEN })]));
    const body = parse(await tool('search_registry').handler({ query: 'riesling' }, CTX));
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ label_sweetness: null, display_name: 'Riesling Spätlese' });
    expect(body.data[1]).toMatchObject({ label_sweetness: TROCKEN, display_name: 'Riesling Kabinett trocken' });
  });
});

describe('add_bottle with wine_id', () => {
  test('the wine summary says label_sweetness null for a legacy row, and the term for a termed one', async () => {
    resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
    addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2019', status: 'active' } });

    findVisibleWine.mockResolvedValue(legacy());
    let body = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019' }, CTX));
    expect(body.data.wine).toMatchObject({ label_sweetness: null, display_name: 'Riesling Spätlese' });
    // The lookup populated the term.
    expect(findVisibleWine.mock.calls[0][1].populate).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'labelSweetness' })]));

    findVisibleWine.mockResolvedValue(legacy({ labelSweetness: TROCKEN }));
    body = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019' }, CTX));
    expect(body.data.wine).toMatchObject({ label_sweetness: TROCKEN, display_name: 'Riesling Spätlese trocken' });
  });
});
