/**
 * The COMPLETENESS scan — rows that are not wrong, just blank.
 *
 * Pins the queue contract: WHAT counts as incomplete (region null; a missing
 * appellation is legitimate for most of the world and must not flood the
 * queue), what is excluded (quarantine, pending-identity — already in its own
 * queue), the clearance suppression and its audit view, the impact-first
 * ranking, and the count-only shape the health job uses.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const {
  incompleteGeographyRows,
  stillIncomplete,
  GEOGRAPHY_INCOMPLETE_CHECK_ID,
} = require('./registryCompleteness');

const leanChain = (rows) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
    lean: jest.fn().mockResolvedValue(rows),
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(leanChain([]));
  WineDefinition.countDocuments.mockResolvedValue(0);
  Bottle.aggregate.mockResolvedValue([]);
});

describe('incompleteGeographyRows — the filter', () => {
  test('selects region-null rows, excluding quarantine and pending-identity, suppressing cleared ones', async () => {
    WineDefinition.countDocuments.mockResolvedValue(3);
    await incompleteGeographyRows({});

    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.region).toBeNull();
    expect(filter.nonWine).toEqual({ $ne: true });
    // Pending-identity rows have their own completion queue — counting them
    // here would double-count the same work.
    expect(filter.pendingIdentity).toEqual({ $ne: true });
    // Cleared rows (legitimately region-less) stay out of the outstanding view.
    expect(filter.crossChecksCleared).toEqual({ $ne: GEOGRAPHY_INCOMPLETE_CHECK_ID });
  });

  test('a missing APPELLATION alone is never flagged — most of the world has none', async () => {
    await incompleteGeographyRows({});
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter).not.toHaveProperty('appellation');
  });

  test('includeCleared drops the suppression (the audit view)', async () => {
    await incompleteGeographyRows({ includeCleared: true });
    expect(WineDefinition.find.mock.calls[0][0]).not.toHaveProperty('crossChecksCleared');
  });
});

describe('incompleteGeographyRows — ranking and shape', () => {
  test('most-owned first, then appellation leads before blank rows', async () => {
    WineDefinition.countDocuments.mockResolvedValue(4);
    WineDefinition.find.mockReturnValue(leanChain([
      { _id: 'w-blank-0', name: 'A', producer: 'P', appellation: null, country: { name: 'France' } },
      { _id: 'w-lead-0', name: 'B', producer: 'P', appellation: 'Chablis', country: { name: 'France' } },
      { _id: 'w-owned-2', name: 'C', producer: 'P', appellation: null, country: { name: 'France' } },
      { _id: 'w-owned-5', name: 'D', producer: 'P', appellation: 'Rioja', country: { name: 'Spain' } },
    ]));
    Bottle.aggregate.mockResolvedValue([
      { _id: 'w-owned-2', n: 2 },
      { _id: 'w-owned-5', n: 5 },
    ]);

    const res = await incompleteGeographyRows({});
    expect(res.rows.map(r => r._id)).toEqual([
      'w-owned-5',  // 5 bottles
      'w-owned-2',  // 2 bottles
      'w-lead-0',   // 0 bottles but has a lead
      'w-blank-0',  // 0 bottles, no lead
    ]);
    expect(res.rows[0]).toMatchObject({
      appellation: 'Rioja', country: 'Spain', bottleCount: 5, hasLead: true, cleared: false,
    });
    expect(res.rows[3].hasLead).toBe(false);
  });

  test('the cleared flag rides on each row (the audit view renders it)', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      { _id: 'w1', name: 'A', producer: 'P', appellation: null, country: null,
        crossChecksCleared: [GEOGRAPHY_INCOMPLETE_CHECK_ID] },
      { _id: 'w2', name: 'B', producer: 'P', appellation: null, country: null,
        crossChecksCleared: ['some-other-rule.v1'] },
    ]));
    const res = await incompleteGeographyRows({ includeCleared: true });
    expect(res.rows.find(r => r._id === 'w1').cleared).toBe(true);
    expect(res.rows.find(r => r._id === 'w2').cleared).toBe(false);
  });
});

describe('incompleteGeographyRows — the health-job shape', () => {
  test('limit 0 returns the count without touching bottles at all', async () => {
    WineDefinition.countDocuments.mockResolvedValueOnce(180).mockResolvedValueOnce(4);
    const res = await incompleteGeographyRows({ limit: 0 });

    expect(res.total).toBe(180);
    expect(res.clearedCount).toBe(4);
    expect(res.rows).toEqual([]);
    // The expensive half is skipped entirely.
    expect(WineDefinition.find).not.toHaveBeenCalled();
    expect(Bottle.aggregate).not.toHaveBeenCalled();
  });
});

describe('stillIncomplete — the clearance re-detect', () => {
  test('returns only the ids that are STILL region-less', async () => {
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'a' }]) }),
    });
    const set = await stillIncomplete(['a', 'b']);
    expect([...set]).toEqual(['a']); // 'b' gained a region since the client rendered

    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.region).toBeNull();
    expect(filter.nonWine).toEqual({ $ne: true });
    expect(filter.pendingIdentity).toEqual({ $ne: true });
  });
});
