/**
 * services/crossFieldScan — the load-and-flatten layer over the pure rules in
 * utils/crossFieldChecks (unit-tested there). Pinned here:
 *   - the registry query excludes quarantined non-wines (same contract as
 *     every other admin scan pool) and projects every field the rules read
 *   - region/country ObjectIds are resolved to display names BEFORE the rules
 *     run (region-is-country only works on the resolved name)
 *   - clearance filtering: a cleared rule stops counting for that row, still
 *     counts on rows not cleared; clearedCount mirrors the queue's badge
 *   - per-rule ruleCounts — the numbers the weekly watchdog snapshots
 *   - detectCrossFieldForWines ignores clearances (the clearance-write path)
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Appellation = require('../models/Appellation');
const Region = require('../models/Region');
const Country = require('../models/Country');
const Grape = require('../models/Grape');
const { CROSS_FIELD_CHECK_SELECT } = require('../utils/crossFieldChecks');
const { scanCrossFieldChecks, detectCrossFieldForWines } = require('./crossFieldScan');

// Taxonomy chain: find({}).select(...).lean()
const taxonomyChain = (rows) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
});

// Wine chain serves both query shapes the service issues:
//   scan:   find(filter).select(...).sort(...).lean()
//   detect: find({ _id: { $in } }).select(...).lean()
const wineChain = (rows) => {
  const select = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
    lean: jest.fn().mockResolvedValue(rows),
  });
  return { select };
};

const REGION_SPAIN = 'aaa000000000000000000001';
const REGION_RIOJA = 'aaa000000000000000000002';
const COUNTRY_ES = 'bbb000000000000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  Appellation.find.mockReturnValue(taxonomyChain([
    { _id: 'ap1', name: 'Monbazillac', normalizedName: 'monbazillac' },
  ]));
  Region.find.mockReturnValue(taxonomyChain([
    // The junk Region doc predating the mint gate — its NAME is a country.
    { _id: REGION_SPAIN, name: 'Spain', normalizedName: 'spain' },
    { _id: REGION_RIOJA, name: 'Rioja', normalizedName: 'rioja' },
  ]));
  Country.find.mockReturnValue(taxonomyChain([
    { _id: COUNTRY_ES, name: 'Spain', normalizedName: 'spain' },
  ]));
  Grape.find.mockReturnValue(taxonomyChain([
    { _id: 'g1', name: 'Cabernet Sauvignon', normalizedName: 'cabernet sauvignon' },
  ]));
  WineDefinition.find.mockReturnValue(wineChain([]));
});

describe('scanCrossFieldChecks', () => {
  test('excludes non-wines and projects every field the rules read', async () => {
    const chain = wineChain([]);
    WineDefinition.find.mockReturnValue(chain);

    await scanCrossFieldChecks();

    expect(WineDefinition.find).toHaveBeenCalledWith({ nonWine: { $ne: true } });
    const selectArg = chain.select.mock.calls[0][0];
    for (const field of CROSS_FIELD_CHECK_SELECT.split(' ')) {
      expect(selectArg).toContain(field);
    }
  });

  test('flags misplaced values, resolving region ids to names first', async () => {
    WineDefinition.find.mockReturnValue(wineChain([
      { _id: 'w1', name: 'Sec', producer: 'Monbazillac', appellation: null, region: null, country: COUNTRY_ES },
      { _id: 'w2', name: 'Crianza', producer: 'Bodegas Muga', appellation: null, region: REGION_SPAIN, country: COUNTRY_ES },
      { _id: 'w3', name: 'Reserva', producer: 'La Rioja Alta', appellation: null, region: REGION_RIOJA, country: COUNTRY_ES },
    ]));

    const { rows, ruleCounts, total, scannedCount } = await scanCrossFieldChecks();

    expect(total).toBe(2);
    expect(scannedCount).toBe(3);

    const w1 = rows.find(r => String(r.wine._id) === 'w1');
    expect(w1.hits).toEqual([{ check: 'producer-is-appellation.v1', detail: 'Monbazillac' }]);
    expect(w1.wine.country).toBe('Spain'); // id resolved for display

    const w2 = rows.find(r => String(r.wine._id) === 'w2');
    expect(w2.wine.region).toBe('Spain'); // resolved BEFORE the rule ran
    expect(w2.hits).toEqual([{ check: 'region-is-country.v1', detail: 'Spain' }]);

    // "La Rioja Alta" is a full-string non-match; region Rioja is a real region.
    expect(rows.some(r => String(r.wine._id) === 'w3')).toBe(false);

    expect(ruleCounts['producer-is-appellation.v1']).toBe(1);
    expect(ruleCounts['region-is-country.v1']).toBe(1);
    expect(ruleCounts['producer-is-grape.v1']).toBe(0);
  });

  test('clearance filtering is per rule, and fully-cleared rows feed clearedCount', async () => {
    WineDefinition.find.mockReturnValue(wineChain([
      // Cleared for the ONE rule it trips → leaves the queue, counts as cleared.
      { _id: 'w1', name: 'Sec', producer: 'Monbazillac', crossChecksCleared: ['producer-is-appellation.v1'] },
      // Cleared for a rule it trips, still tripping another → stays, partial.
      { _id: 'w2', name: 'Sec', producer: 'Monbazillac', appellation: 'Cabernet Sauvignon',
        crossChecksCleared: ['producer-is-appellation.v1'] },
    ]));

    const { rows, ruleCounts, total, clearedCount } = await scanCrossFieldChecks();

    expect(total).toBe(1);
    expect(clearedCount).toBe(1);
    expect(rows[0].hits.map(h => h.check)).toEqual(['appellation-is-grape.v1']);
    expect(rows[0].cleared).toEqual(['producer-is-appellation.v1']);
    expect(ruleCounts['producer-is-appellation.v1']).toBe(0); // both cleared
    expect(ruleCounts['appellation-is-grape.v1']).toBe(1);
  });

  test('ignoreCleared is the audit view: cleared rows return anyway', async () => {
    WineDefinition.find.mockReturnValue(wineChain([
      { _id: 'w1', name: 'Sec', producer: 'Monbazillac', crossChecksCleared: ['producer-is-appellation.v1'] },
    ]));

    const { rows, total } = await scanCrossFieldChecks({ ignoreCleared: true });
    expect(total).toBe(1);
    expect(rows[0].hits.map(h => h.check)).toEqual(['producer-is-appellation.v1']);
  });

  test('checkIds scopes the scan and the counts (the ?check= path)', async () => {
    WineDefinition.find.mockReturnValue(wineChain([
      { _id: 'w1', name: 'Sec', producer: 'Monbazillac', appellation: 'Cabernet Sauvignon' },
    ]));

    const { rows, ruleCounts } = await scanCrossFieldChecks({ checkIds: ['appellation-is-grape.v1'] });
    expect(rows[0].hits.map(h => h.check)).toEqual(['appellation-is-grape.v1']);
    expect(Object.keys(ruleCounts)).toEqual(['appellation-is-grape.v1']);
  });

  test('loads each taxonomy collection exactly once per scan', async () => {
    WineDefinition.find.mockReturnValue(wineChain([]));
    await scanCrossFieldChecks();
    expect(Appellation.find).toHaveBeenCalledTimes(1);
    expect(Region.find).toHaveBeenCalledTimes(1);
    expect(Country.find).toHaveBeenCalledTimes(1);
    expect(Grape.find).toHaveBeenCalledTimes(1);
  });
});

describe('detectCrossFieldForWines', () => {
  test('re-detects ignoring clearances; clean wines map to []; missing ids are absent', async () => {
    WineDefinition.find.mockReturnValue(wineChain([
      { _id: 'w1', name: 'Sec', producer: 'Monbazillac', crossChecksCleared: ['producer-is-appellation.v1'] },
      { _id: 'w2', name: 'Albe', producer: 'G.D. Vajra' },
    ]));

    const hits = await detectCrossFieldForWines(['w1', 'w2', 'w3'], ['producer-is-appellation.v1']);

    expect(WineDefinition.find).toHaveBeenCalledWith({ _id: { $in: ['w1', 'w2', 'w3'] } });
    expect(hits.get('w1')).toEqual(['producer-is-appellation.v1']); // clearance ignored — caller is about to write it
    expect(hits.get('w2')).toEqual([]);
    expect(hits.has('w3')).toBe(false);
  });
});
