/**
 * services/wineVisibility — the ONE pending-identity visibility rule.
 *
 * The security audit found nine routes that answered "does this wine exist?"
 * with a bare findById, so a stranger could reach a pendingIdentity row through
 * reviews, the wishlist, recommendations (which EMAILS the name to a third
 * party), wine reports, wine requests, bottles and three MCP tools. This suite
 * pins the rule they all now share, and pins it as a QUERY CLAUSE rather than a
 * post-filter — the dead `raw.pendingIdentity === true` check in
 * mcp/tools/wines.js was dead precisely because the projection omitted the
 * field, and a post-filter cannot see what it was not given.
 */

jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { wineVisibilityFilter, canSeeWine, findVisibleWine, isCurator } = require('./wineVisibility');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const WINE = 'cccccccccccccccccccccccc';

beforeEach(() => jest.clearAllMocks());

describe('wineVisibilityFilter — the clause that goes into the query', () => {
  test('an anonymous caller gets a plain exclusion (nobody to compare against)', () => {
    expect(wineVisibilityFilter()).toEqual({ $or: [{ pendingIdentity: { $ne: true } }] });
  });

  test('a signed-in caller additionally matches their OWN pending rows', () => {
    expect(wineVisibilityFilter({ userId: ME, roles: ['user'] })).toEqual({
      $or: [{ pendingIdentity: { $ne: true } }, { pendingIdentity: true, createdBy: ME }],
    });
  });

  test.each([['somm'], ['admin']])('%s gets an EMPTY clause — completing these rows is the job', (role) => {
    expect(wineVisibilityFilter({ userId: STRANGER, roles: [role] })).toEqual({});
  });

  test('an unrelated role is not curation', () => {
    expect(isCurator(['moderator'])).toBe(false);
    expect(isCurator(undefined)).toBe(false);
  });
});

describe('canSeeWine — the same rule for an already-loaded document', () => {
  const pending = { pendingIdentity: true, createdBy: ME };

  test('a non-pending wine is visible to everyone, signed in or not', () => {
    expect(canSeeWine({ pendingIdentity: false }, { userId: STRANGER })).toBe(true);
    expect(canSeeWine({}, {})).toBe(true);
  });

  test('a pending wine is visible to its creator', () => {
    expect(canSeeWine(pending, { userId: ME, roles: ['user'] })).toBe(true);
  });

  test('a pending wine is NOT visible to a stranger', () => {
    expect(canSeeWine(pending, { userId: STRANGER, roles: ['user'] })).toBe(false);
  });

  test('a pending wine is visible to curation', () => {
    expect(canSeeWine(pending, { userId: STRANGER, roles: ['somm'] })).toBe(true);
    expect(canSeeWine(pending, { userId: STRANGER, roles: ['admin'] })).toBe(true);
  });

  test('a missing wine is never visible', () => {
    expect(canSeeWine(null, { roles: ['admin'] })).toBe(false);
  });
});

describe('findVisibleWine — the drop-in replacement for findById', () => {
  test('the exclusion is part of the QUERY, not applied to the result', async () => {
    WineDefinition.findOne.mockResolvedValue(null);
    await findVisibleWine(WINE, { userId: ME, roles: ['user'] });
    expect(WineDefinition.findOne).toHaveBeenCalledWith({
      _id: WINE,
      $or: [{ pendingIdentity: { $ne: true } }, { pendingIdentity: true, createdBy: ME }],
    });
  });

  test('select / populate / lean are applied in that order when asked for', async () => {
    const lean = jest.fn().mockResolvedValue({ _id: WINE });
    const populate = jest.fn().mockReturnValue({ lean });
    const select = jest.fn().mockReturnValue({ populate });
    WineDefinition.findOne.mockReturnValue({ select });

    const out = await findVisibleWine(WINE, {
      userId: ME, select: 'name producer', populate: ['country'], lean: true,
    });

    expect(select).toHaveBeenCalledWith('name producer');
    expect(populate).toHaveBeenCalledWith(['country']);
    expect(lean).toHaveBeenCalled();
    expect(out).toEqual({ _id: WINE });
  });

  test('a hidden row and a missing id are indistinguishable to the caller', async () => {
    WineDefinition.findOne.mockResolvedValue(null);
    await expect(findVisibleWine(WINE, { userId: STRANGER })).resolves.toBeNull();
  });
});
