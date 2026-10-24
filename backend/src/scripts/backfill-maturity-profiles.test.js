/**
 * scripts/backfill-maturity-profiles — re-seeds pending maturity rows for
 * wine+vintage pairs that have bottles but no profile, and keeps the wines
 * ensurePendingVintageProfile keeps out of the queue (non-wine quarantine,
 * pending identity, drafts) out of it here too. Models mocked.
 */
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), insertMany: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), distinct: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/User', () => ({}));

const mongoose = require('mongoose');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { MATURITY_QUEUE_EXCLUDED } = require('../utils/vintageProfile');
const { run, filterEligible } = require('./backfill-maturity-profiles');

const oid = (c) => new mongoose.Types.ObjectId(c.repeat(24));
const lean = (rows) => ({ lean: () => Promise.resolve(rows) });

const WINE = oid('a');      // an ordinary wine
const CIDER = oid('b');     // non-wine quarantine
const PENDING = oid('c');   // pending identity / draft
const REVIEWED = oid('d');  // already has a profile

let logs;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(mongoose, 'connect').mockResolvedValue();
  jest.spyOn(mongoose, 'disconnect').mockResolvedValue();
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));

  Bottle.aggregate.mockResolvedValue([
    { _id: { wineDefinition: WINE, vintage: '2018' } },
    { _id: { wineDefinition: WINE, vintage: 'NV' } },
    { _id: { wineDefinition: CIDER, vintage: '2020' } },
    { _id: { wineDefinition: PENDING, vintage: 'NV' } },
    { _id: { wineDefinition: REVIEWED, vintage: '2015' } },
  ]);
  WineVintageProfile.find.mockReturnValue(lean([{ wineDefinition: REVIEWED, vintage: '2015' }]));
  WineDefinition.distinct.mockResolvedValue([CIDER, PENDING]);
  WineDefinition.find.mockReturnValue(lean([]));
  WineVintageProfile.insertMany.mockImplementation(async (docs) => docs);
});

afterEach(() => jest.restoreAllMocks());

describe('filterEligible', () => {
  test('drops the pairs whose wine is excluded, whatever the id type, and keeps the rest in order', () => {
    const missing = [
      { wineDefinition: WINE, vintage: '2018' },
      { wineDefinition: CIDER, vintage: '2020' },
      { wineDefinition: WINE, vintage: 'NV' },
      { wineDefinition: PENDING, vintage: 'NV' },
    ];
    expect(filterEligible(missing, [CIDER, String(PENDING)])).toEqual([
      { wineDefinition: WINE, vintage: '2018' },
      { wineDefinition: WINE, vintage: 'NV' },
    ]);
    expect(filterEligible(missing, [])).toEqual(missing);
  });
});

describe('run', () => {
  test('asks for the excluded wines among the missing pairs with the shared queue exclusion', async () => {
    await run({ apply: false });
    expect(WineDefinition.distinct).toHaveBeenCalledTimes(1);
    const [field, filter] = WineDefinition.distinct.mock.calls[0];
    expect(field).toBe('_id');
    expect(filter.$or).toEqual(MATURITY_QUEUE_EXCLUDED.$or);
    expect(filter._id.$in.map(String).sort()).toEqual([WINE, CIDER, PENDING].map(String).sort());
  });

  test('--apply inserts only the eligible pairs, pending, with relative derived from the vintage', async () => {
    await run({ apply: true });
    expect(WineVintageProfile.insertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = WineVintageProfile.insertMany.mock.calls[0];
    expect(docs).toEqual([
      { wineDefinition: WINE, vintage: '2018', status: 'pending', relative: false },
      { wineDefinition: WINE, vintage: 'NV', status: 'pending', relative: true },
    ]);
    expect(opts).toEqual({ ordered: false });
  });

  test('the dry run reports the excluded count and writes nothing', async () => {
    await run({ apply: false });
    expect(WineVintageProfile.insertMany).not.toHaveBeenCalled();
    expect(logs.some((l) => /excluded \(non-wine \/ pending identity \/ draft\):\s+2$/.test(l))).toBe(true);
    expect(logs.some((l) => /to backfill:\s+2$/.test(l))).toBe(true);
  });

  test('when every missing pair is excluded there is nothing to do', async () => {
    WineDefinition.distinct.mockResolvedValue([WINE, CIDER, PENDING]);
    await run({ apply: true });
    expect(WineVintageProfile.insertMany).not.toHaveBeenCalled();
    expect(logs).toContain('\nNothing to do.');
    expect(mongoose.disconnect).toHaveBeenCalled();
  });
});
