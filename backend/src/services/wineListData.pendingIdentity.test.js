/**
 * H-5, wine-list half — loadWineMap feeds routes/wineListPublic.js, which has
 * NO auth at all. The write gate (routes/wineLists.js PUT, mcp add_to_list)
 * stops new pending attachments; this is the defence in depth for rows attached
 * BEFORE that gate existed, which would otherwise still render a stranger's
 * hidden wine to the open internet (and into the PDF, and the stats endpoint).
 */

jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));

const WineDefinition = require('../models/WineDefinition');
const { loadWineMap } = require('./wineListData');

const oid = (c) => c.repeat(24);
const OK_WINE = oid('a');
const PENDING_WINE = oid('b');

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
  }),
});

const list = {
  cellar: oid('c'),
  structureMode: 'custom',
  sections: [{
    entries: [
      { wine: OK_WINE, vintage: '2019', bottleSize: '750ml' },
      { wine: PENDING_WINE, vintage: '2020', bottleSize: '750ml' },
    ],
  }],
};

beforeEach(() => jest.clearAllMocks());

test('the wine query excludes pendingIdentity rows', async () => {
  WineDefinition.find.mockReturnValue(chain([]));

  await loadWineMap(list);

  expect(WineDefinition.find).toHaveBeenCalledWith(expect.objectContaining({
    pendingIdentity: { $ne: true },
  }));
});

test('an excluded entry simply drops out — the same handling a deleted wine gets', async () => {
  // Mongo returns only the visible wine; the pending one is absent.
  WineDefinition.find.mockReturnValue(chain([{ _id: { toString: () => OK_WINE }, name: 'Barolo' }]));

  const map = await loadWineMap(list);

  expect(map.size).toBe(1);
  expect([...map.values()][0].wine.name).toBe('Barolo');
  expect([...map.keys()].some((k) => k.startsWith(PENDING_WINE))).toBe(false);
});

describe('the write gate judges only what a save ADDS', () => {
  const { allEntries } = require('./wineListData');

  // Mirrors routes/wineLists.pendingWineAdded: a list that already carried a
  // pending row from before the gate existed must stay EDITABLE — otherwise
  // its owner cannot even remove the entry. The read-side exclusion above is
  // what keeps that row off the public page.
  const idsOf = (l) => new Set(allEntries(l).filter(e => e.wine).map(e => String(e.wine)));

  test('re-saving a list that already held the pending row adds nothing', () => {
    const previous = idsOf(list);
    const added = [...idsOf(list)].filter((id) => !previous.has(id));
    expect(added).toEqual([]);
  });

  test('introducing a new wine is what the gate sees', () => {
    const previous = idsOf({ ...list, sections: [{ entries: [{ wine: OK_WINE }] }] });
    const added = [...idsOf(list)].filter((id) => !previous.has(id));
    expect(added).toEqual([PENDING_WINE]);
  });
});
