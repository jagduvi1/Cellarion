/**
 * Who may render on a wine list — services/wineListData.ownerWineFilter.
 *
 * loadWineMap feeds routes/wineListPublic.js, which has NO auth at all, so the
 * wine query is the one place that decides what the open internet sees. The
 * rule (support ticket 2026-10-09 — an owner could not save a list of their
 * own cellar): every published registry wine, plus the pending-identity rows
 * that are the owner's OWN — created by them, or held by a bottle in a cellar
 * they own or belong to. A stranger's hidden row is never queried for, so it
 * drops out exactly like a deleted wine. Expressed as a QUERY filter on
 * purpose: pendingIdentity/createdBy are not in the projection, and a
 * post-filter on an absent field passes every row.
 */

jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn().mockResolvedValue([]), distinct: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { loadWineMap, ownerWineFilter } = require('./wineListData');

const oid = (c) => c.repeat(24);
const OWNER = oid('1');
const OK_WINE = oid('a');
const OWN_PENDING = oid('b');
const HELD_PENDING = oid('d');
const STRANGER_PENDING = oid('e');
const CELLAR = oid('c');
const SHARED_CELLAR = oid('f');
const ALL = [OK_WINE, OWN_PENDING, HELD_PENDING, STRANGER_PENDING];

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
  }),
});

const list = {
  user: OWNER,
  cellar: CELLAR,
  structureMode: 'custom',
  sections: [{
    entries: [
      { wine: OK_WINE, vintage: '2019', bottleSize: '750ml' },
      { wine: OWN_PENDING, vintage: '2020', bottleSize: '750ml' },
      { wine: HELD_PENDING, vintage: '2021', bottleSize: '750ml' },
      { wine: STRANGER_PENDING, vintage: '2022', bottleSize: '750ml' },
    ],
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([CELLAR, SHARED_CELLAR]) });
  Bottle.distinct.mockResolvedValue([HELD_PENDING]);
});

describe('ownerWineFilter', () => {
  test("admits published wines, the owner's own pending rows and pending rows held in the owner's cellars — nothing else", async () => {
    const filter = await ownerWineFilter(OWNER, ALL);

    // Cellars the owner owns or belongs to, live ones only...
    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: OWNER }, { 'members.user': OWNER }], deletedAt: null });
    // ...and which of the candidate wines a bottle in them holds
    expect(Bottle.distinct).toHaveBeenCalledWith('wineDefinition', {
      cellar: { $in: [CELLAR, SHARED_CELLAR] },
      wineDefinition: { $in: ALL },
    });
    expect(filter).toEqual({
      _id: { $in: ALL },
      $or: [
        { pendingIdentity: { $ne: true } },
        // the owner's own rows, private drafts included
        { pendingIdentity: true, createdBy: OWNER },
        // held rows: a member's unread label yes, a member's PRIVATE DRAFT never
        { pendingIdentity: true, draft: { $ne: true }, _id: { $in: [HELD_PENDING] } },
      ],
    });
  });

  test('duplicate ids collapse; no candidate wines means no cellar or bottle lookup at all', async () => {
    const filter = await ownerWineFilter(OWNER, []);
    expect(Cellar.find).not.toHaveBeenCalled();
    expect(Bottle.distinct).not.toHaveBeenCalled();
    expect(filter._id).toEqual({ $in: [] });

    const dup = await ownerWineFilter(OWNER, [OK_WINE, OK_WINE]);
    expect(dup._id).toEqual({ $in: [OK_WINE] });
  });

  test('an owner with no live cellar still gets the rows they created, and holds nothing', async () => {
    Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    const filter = await ownerWineFilter(OWNER, [OWN_PENDING]);
    expect(Bottle.distinct).not.toHaveBeenCalled();
    expect(filter.$or).toEqual([
      { pendingIdentity: { $ne: true } },
      { pendingIdentity: true, createdBy: OWNER },
      { pendingIdentity: true, draft: { $ne: true }, _id: { $in: [] } },
    ]);
  });
});

describe('loadWineMap', () => {
  test('queries the wines through the owner rule — the list owner, not any viewer', async () => {
    WineDefinition.find.mockReturnValue(chain([]));

    await loadWineMap(list);

    expect(WineDefinition.find).toHaveBeenCalledWith(expect.objectContaining({
      _id: { $in: ALL },
      $or: expect.arrayContaining([{ pendingIdentity: true, createdBy: OWNER }]),
    }));
  });

  test('a row Mongo does not return simply drops out — the same handling a deleted wine gets', async () => {
    // Mongo returns the rows the rule admits; the stranger's hidden one is absent.
    WineDefinition.find.mockReturnValue(chain([
      { _id: { toString: () => OK_WINE }, name: 'Barolo' },
      { _id: { toString: () => OWN_PENDING }, name: 'Rosato' },
    ]));

    const map = await loadWineMap(list);

    expect([...map.values()].map((v) => v.wine.name)).toEqual(['Barolo', 'Rosato']);
    expect([...map.keys()].some((k) => k.startsWith(STRANGER_PENDING))).toBe(false);
  });
});
