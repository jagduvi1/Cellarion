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
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ exists: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { wineVisibilityFilter, canSeeWine, findVisibleWine, isCurator, DRAFT_EXCLUDED } = require('./wineVisibility');

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

  test.each([['somm'], ['admin']])('%s sees every pending row (completing them is the job) but NOT another user\'s private draft', (role) => {
    expect(wineVisibilityFilter({ userId: STRANGER, roles: [role] })).toEqual({
      $or: [{ draft: { $ne: true } }, { draft: true, createdBy: STRANGER }],
    });
  });

  test('noDrafts narrows every viewer to "no draft at all", the caller\'s own included', () => {
    expect(wineVisibilityFilter({ userId: ME, roles: ['user'] }, { noDrafts: true })).toEqual({
      $or: [{ pendingIdentity: { $ne: true } }, { pendingIdentity: true, createdBy: ME }],
      draft: { $ne: true },
    });
    expect(wineVisibilityFilter({ userId: ME, roles: ['admin'] }, { noDrafts: true }).draft).toEqual({ $ne: true });
    expect(DRAFT_EXCLUDED).toEqual({ draft: { $ne: true } });
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

// ─── Private drafts (support ticket 2026-09-12) ──────────────────────────────

describe('canSeeWine — a private draft is creator-only, curators included', () => {
  const draft = { draft: true, pendingIdentity: true, createdBy: ME };

  test('the creator sees their draft', () => {
    expect(canSeeWine(draft, { userId: ME, roles: ['user'] })).toBe(true);
  });

  test('a stranger does not', () => {
    expect(canSeeWine(draft, { userId: STRANGER, roles: ['user'] })).toBe(false);
  });

  test.each([['somm'], ['admin']])('a %s does not either — a draft is nobody\'s registry content yet', (role) => {
    expect(canSeeWine(draft, { userId: STRANGER, roles: [role] })).toBe(false);
  });

  test('anonymous never', () => {
    expect(canSeeWine(draft, {})).toBe(false);
  });
});

describe('findVisibleWine — drafts via a shared cellar, and noDrafts', () => {
  const chain = (result) => {
    const q = { select: jest.fn(), populate: jest.fn(), lean: jest.fn() };
    q.select.mockReturnValue(q); q.populate.mockReturnValue(q); q.lean.mockReturnValue(q);
    q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return q;
  };

  test('noDrafts rides into the query filter', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));
    await findVisibleWine(WINE, { userId: ME, roles: ['user'], noDrafts: true });
    expect(WineDefinition.findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: WINE, draft: { $ne: true } }));
  });

  test('a miss without viaSharedCellar stays a miss — no second query, no cellar lookup', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));
    expect(await findVisibleWine(WINE, { userId: STRANGER, roles: ['user'] })).toBeNull();
    expect(WineDefinition.findOne).toHaveBeenCalledTimes(1);
    expect(Cellar.find).not.toHaveBeenCalled();
  });

  test('viaSharedCellar: a member of a shared cellar holding a bottle of the draft may READ it', async () => {
    const draftDoc = { _id: WINE, draft: true, createdBy: ME };
    WineDefinition.findOne
      .mockReturnValueOnce(chain(null))       // the ordinary visibility query misses
      .mockReturnValueOnce(chain(draftDoc));  // the draft re-read after the cellar check
    Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['c1']) });
    Bottle.exists.mockResolvedValue({ _id: 'b1' });

    const got = await findVisibleWine(WINE, { userId: STRANGER, roles: ['user'], viaSharedCellar: true });

    expect(got).toBe(draftDoc);
    // Owner OR member: an editor's draft bottle in someone else's cellar must
    // leave that owner able to read it (audit 2026-09-12).
    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: STRANGER }, { 'members.user': STRANGER }], deletedAt: null });
    expect(Bottle.exists).toHaveBeenCalledWith({ wineDefinition: WINE, cellar: { $in: ['c1'] } });
    expect(WineDefinition.findOne).toHaveBeenLastCalledWith({ _id: WINE, draft: true });
  });

  test('viaSharedCellar: no shared cellar holds it → still not visible', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));
    Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    expect(await findVisibleWine(WINE, { userId: STRANGER, roles: ['user'], viaSharedCellar: true })).toBeNull();
    expect(Bottle.exists).not.toHaveBeenCalled();
  });

  test('viaSharedCellar never applies to an anonymous viewer or alongside noDrafts', async () => {
    WineDefinition.findOne.mockReturnValue(chain(null));
    expect(await findVisibleWine(WINE, { viaSharedCellar: true })).toBeNull();
    expect(await findVisibleWine(WINE, { userId: STRANGER, roles: ['user'], viaSharedCellar: true, noDrafts: true })).toBeNull();
    expect(Cellar.find).not.toHaveBeenCalled();
  });
});
