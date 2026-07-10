/**
 * Guards the GDPR retention invariants of the daily purge job:
 *  - RETENTION_DAYS is 30 — the DELETE routes promise "data retained 30 days",
 *    and this constant is what makes that promise true;
 *  - only cellars/racks soft-deleted MORE than 30 days ago are hard-deleted
 *    (exact cutoff-date query shape);
 *  - NFC tags are freed on ALL soft-deleted racks (no cutoff — self-heals
 *    racks deleted before the soft-delete route started unsetting the tag);
 *  - a purge failure on one cellar never blocks the remaining cellars.
 */
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn(), deleteMany: jest.fn() }));
jest.mock('./cellarPurge', () => ({ purgeCellarPermanently: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const { purgeCellarPermanently } = require('./cellarPurge');
const { logAudit } = require('./audit');
const { runCellarRetentionPurge, RETENTION_DAYS } = require('./cellarRetentionJob');

const NOW = new Date('2026-07-10T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

const PURGE_COUNTS = { racksDeleted: 1, bottlesDeleted: 4, imagesDeleted: 2 };

function setupMocks({ expired = [], racksDeleted = 0, tagsFreed = 0 } = {}) {
  Rack.updateMany.mockResolvedValue({ modifiedCount: tagsFreed });
  Rack.deleteMany.mockResolvedValue({ deletedCount: racksDeleted });
  Cellar.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(expired) }),
  });
  purgeCellarPermanently.mockResolvedValue(PURGE_COUNTS);
}

let errorSpy;
let logSpy;

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  setupMocks();
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('RETENTION_DAYS', () => {
  test('is 30 — the GDPR "data retained 30 days" promise', () => {
    expect(RETENTION_DAYS).toBe(30);
  });
});

describe('runCellarRetentionPurge', () => {
  test('selects only cellars soft-deleted more than RETENTION_DAYS ago (exact cutoff query)', async () => {
    await runCellarRetentionPurge();

    // $lt cutoff = now - 30 days: a cellar deleted exactly at the cutoff (or
    // later) survives; only strictly-older deletions are purged. $type: 'date'
    // excludes docs where deletedAt is null/absent.
    expect(Cellar.find).toHaveBeenCalledWith({
      deletedAt: { $type: 'date', $lt: CUTOFF },
    });
  });

  test('projects only the fields the audit entry needs', async () => {
    const select = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    Cellar.find.mockReturnValue({ select });

    await runCellarRetentionPurge();

    expect(select).toHaveBeenCalledWith('name user deletedAt');
  });

  test('frees NFC tags on ALL soft-deleted racks — no cutoff, $unset rfidTag', async () => {
    await runCellarRetentionPurge();

    // Deliberately NOT restricted to the 30-day window: the unique index on
    // rfidTag has no deletedAt filter, so a tag held by any soft-deleted rack
    // blocks re-linking until the field is unset.
    expect(Rack.updateMany).toHaveBeenCalledWith(
      { deletedAt: { $type: 'date' }, rfidTag: { $exists: true } },
      { $unset: { rfidTag: '' } }
    );
    const filter = Rack.updateMany.mock.calls[0][0];
    expect(filter.deletedAt).not.toHaveProperty('$lt');
  });

  test('purges each expired cellar via the permanent-delete cascade and audits it', async () => {
    const expired = [
      { _id: 'cellar-1', name: 'Old Cave', user: 'user-1', deletedAt: new Date('2026-06-01') },
      { _id: 'cellar-2', name: 'Gone Cellar', user: 'user-2', deletedAt: new Date('2026-05-15') },
    ];
    setupMocks({ expired });

    const result = await runCellarRetentionPurge();

    expect(purgeCellarPermanently).toHaveBeenCalledTimes(2);
    expect(purgeCellarPermanently).toHaveBeenCalledWith('cellar-1');
    expect(purgeCellarPermanently).toHaveBeenCalledWith('cellar-2');
    expect(result.cellarsPurged).toBe(2);

    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledWith(
      null,
      'cellar.retention_purge',
      { type: 'cellar', id: 'cellar-1', cellarId: 'cellar-1' },
      {
        name: 'Old Cave',
        owner: 'user-1',
        deletedAt: expired[0].deletedAt,
        ...PURGE_COUNTS,
      }
    );
  });

  test('per-cellar failure isolation: first purge throws, second cellar is still purged', async () => {
    const expired = [
      { _id: 'cellar-bad', name: 'Bad', user: 'u1', deletedAt: new Date('2026-06-01') },
      { _id: 'cellar-good', name: 'Good', user: 'u2', deletedAt: new Date('2026-06-01') },
    ];
    setupMocks({ expired });
    purgeCellarPermanently
      .mockRejectedValueOnce(new Error('cascade exploded'))
      .mockResolvedValueOnce(PURGE_COUNTS);

    const result = await runCellarRetentionPurge();

    expect(purgeCellarPermanently).toHaveBeenCalledTimes(2);
    expect(purgeCellarPermanently).toHaveBeenLastCalledWith('cellar-good');
    expect(result.cellarsPurged).toBe(1);
    // Failed cellar is logged, not audited as purged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('purge failed for cellar cellar-bad'),
      expect.any(Error)
    );
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      null,
      'cellar.retention_purge',
      expect.objectContaining({ id: 'cellar-good' }),
      expect.any(Object)
    );
  });

  test('hard-deletes individually soft-deleted racks past the same cutoff', async () => {
    setupMocks({ racksDeleted: 3 });

    const result = await runCellarRetentionPurge();

    expect(Rack.deleteMany).toHaveBeenCalledWith({
      deletedAt: { $type: 'date', $lt: CUTOFF },
    });
    expect(result.racksPurged).toBe(3);
  });

  test('returns the purge summary { cellarsPurged, racksPurged, tagsFreed }', async () => {
    setupMocks({
      expired: [{ _id: 'c1', name: 'X', user: 'u', deletedAt: new Date('2026-06-01') }],
      racksDeleted: 2,
      tagsFreed: 5,
    });

    await expect(runCellarRetentionPurge()).resolves.toEqual({
      cellarsPurged: 1,
      racksPurged: 2,
      tagsFreed: 5,
    });
  });

  test('idle run: purges nothing, logs nothing, returns all zeros', async () => {
    const result = await runCellarRetentionPurge();

    expect(purgeCellarPermanently).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ cellarsPurged: 0, racksPurged: 0, tagsFreed: 0 });
  });
});
