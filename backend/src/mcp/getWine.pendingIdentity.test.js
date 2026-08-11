/**
 * H-1 — the regression test that was MISSING when get_wine shipped.
 *
 * get_wine is scope:'public'. It is served to any token AND to the
 * UNAUTHENTICATED /api/mcp/public surface, so there is no caller identity to
 * compare a pending row's creator against: the exclusion is absolute.
 *
 * It was written as a post-filter — `if (raw.pendingIdentity === true)` — over
 * a document fetched with SAFE_SELECT, an INCLUSIVE projection that does not
 * list pendingIdentity. Under .lean() the field was therefore always
 * `undefined`, `undefined === true` is false, and the gate never fired once.
 * nonWine was not filtered here either. This suite pins the fix at the level
 * that cannot rot: the exclusion is in the QUERY, so no projection can blind it.
 */

jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn() }));
jest.mock('../utils/siteUrl', () => ({ siteBaseUrl: () => 'https://cellarion.app' }));

const WineDefinition = require('../models/WineDefinition');
const { allTools } = require('./registry');
require('./tools/wines');

const tool = (name) => allTools().find((t) => t.name === name);

const oid = (c) => c.repeat(24);
const WINE = oid('a');
const CTX = { user: { id: oid('1'), roles: ['user'] } };

const chain = (doc) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
  }),
});

const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('get_wine — pendingIdentity is excluded in the QUERY', () => {
  test('the filter carries BOTH exclusions, so a lean projection cannot defeat them', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));

    await tool('get_wine').handler({ wine_id: WINE }, CTX);

    expect(WineDefinition.findOne).toHaveBeenCalledWith({
      _id: WINE,
      nonWine: { $ne: true },
      pendingIdentity: { $ne: true },
    });
    // findById is what the dead-gate version used — it must not come back.
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });

  test('a hidden row answers the SAME not_found a missing id does — existence never leaks', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));

    const res = await tool('get_wine').handler({ wine_id: WINE }, CTX);
    const body = parse(res);

    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('No registry wine with that id. Find wines via search_registry.');
  });

  test('THE BUG: a pending row that slips through the projection is still not served', async () => {
    // Exactly the old failure mode — the document comes back without the flag
    // because SAFE_SELECT omits it. With the gate in the query this can only
    // happen if the query matched, i.e. the row is genuinely visible; the point
    // of this case is that the handler no longer DEPENDS on reading the flag.
    WineDefinition.findOne.mockReturnValue(chain(null));
    const res = await tool('get_wine').handler({ wine_id: WINE }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('an ordinary registry wine is still served in full', async () => {
    WineDefinition.findOne.mockReturnValue(chain({
      _id: WINE, name: 'Barolo', producer: 'Rinaldi', slug: 'rinaldi-barolo', grapes: [],
    }));

    const res = await tool('get_wine').handler({ wine_id: WINE }, CTX);
    const body = parse(res);

    expect(body.data.name).toBe('Barolo');
    expect(body.data.public_url).toBe('https://cellarion.app/wines/rinaldi-barolo');
  });

  test('an invalid id is rejected before any query runs', async () => {
    const res = await tool('get_wine').handler({ wine_id: 'not-an-id' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(WineDefinition.findOne).not.toHaveBeenCalled();
  });
});

describe('search_registry — the sibling that was already right', () => {
  test('the Mongo fallback carries the same two exclusions', async () => {
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    });

    await tool('search_registry').handler({ query: 'barolo' }, CTX);

    expect(WineDefinition.find).toHaveBeenCalledWith(
      expect.objectContaining({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } }),
      expect.anything(),
    );
  });
});
