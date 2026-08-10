/**
 * Weekly registry-health check (strategy 2026-07-29, R6).
 *
 * Pins the alerting contract: first run writes a baseline and stays silent;
 * an increase notifies every admin ONCE and re-baselines (no weekly re-alert
 * for a standing backlog); a decrease or steady state is silent; a metric
 * added after the baseline skips one cycle instead of alerting on undefined;
 * a notify failure is per-admin non-fatal.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineReport', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../models/RegistryHealthSnapshot', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ scanCrossFieldChecks: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const WineReport = require('../models/WineReport');
const WineRequest = require('../models/WineRequest');
const User = require('../models/User');
const RegistryHealthSnapshot = require('../models/RegistryHealthSnapshot');
const { createNotification } = require('./notifications');
const { scanCrossFieldChecks } = require('./crossFieldScan');
const { runRegistryHealthCheck, computeMetrics, METRIC_LABELS, crossFieldMetricKey } = require('./registryHealthJob');

const leanChain = (result) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
  sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
});

const wine = (over = {}) => ({
  name: 'Albe', producer: 'G.D. Vajra', verifiedChecks: [],
  canonicalKey: 'k', slug: 's', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  WineDefinition.find.mockReturnValue(leanChain([]));
  WineDefinition.aggregate.mockResolvedValue([]);
  WineDefinition.countDocuments.mockResolvedValue(0);
  WineReport.countDocuments.mockResolvedValue(0);
  WineRequest.countDocuments.mockResolvedValue(0);
  User.find.mockReturnValue(leanChain([{ _id: 'admin1' }]));
  RegistryHealthSnapshot.findOne.mockReturnValue(leanChain(null));
  RegistryHealthSnapshot.create.mockResolvedValue({});
  createNotification.mockResolvedValue({});
  scanCrossFieldChecks.mockResolvedValue({ rows: [], ruleCounts: {}, total: 0, clearedCount: 0, scannedCount: 0 });
});

afterEach(() => console.log.mockRestore());

describe('computeMetrics', () => {
  test('counts spelling splits by folded producer, and invariant drift', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      wine({ producer: 'Cave de Ribeauvillé' }),
      wine({ producer: 'Cave de Ribeauville' }),   // split with the above
      wine({ producer: 'Guigal' }),
      wine({ producer: 'Guigal' }),                // same spelling — no split
      wine({ producer: 'Vajra', canonicalKey: null }), // invariant drift
    ]));
    const m = await computeMetrics();
    expect(m.producerSpellingSplits).toBe(1);
    expect(m.missingInvariants).toBe(1);
  });

  test('name-check flags respect per-row verifiedChecks clearances', async () => {
    // "Barolo — Barolo" trips name-equals-producer.v1 unless cleared.
    WineDefinition.find.mockReturnValue(leanChain([
      wine({ name: 'Barolo', producer: 'Barolo' }),
      wine({ name: 'Barolo', producer: 'Barolo', verifiedChecks: ['name-equals-producer.v1'] }),
    ]));
    const m = await computeMetrics();
    expect(m.nameCheckFlags).toBe(1);
  });

  test('cross-field per-rule counts land as metrics under dot-free keys the label map knows', async () => {
    scanCrossFieldChecks.mockResolvedValue({
      rows: [], total: 3, clearedCount: 0, scannedCount: 100,
      ruleCounts: { 'producer-is-appellation.v1': 2, 'region-is-country.v1': 1 },
    });
    const m = await computeMetrics();
    // Mongoose Map keys (RegistryHealthSnapshot.metrics) may not contain '.',
    // so the versioned rule id's dot is folded — and the folded key must be
    // registered in METRIC_LABELS or the regression loop would never diff it.
    expect(m[crossFieldMetricKey('producer-is-appellation.v1')]).toBe(2);
    expect(m[crossFieldMetricKey('region-is-country.v1')]).toBe(1);
    expect(crossFieldMetricKey('producer-is-appellation.v1')).not.toContain('.');
    expect(METRIC_LABELS[crossFieldMetricKey('producer-is-appellation.v1')]).toContain('producer-is-appellation.v1');
  });
});

describe('runRegistryHealthCheck', () => {
  test('first run writes a baseline and never notifies', async () => {
    const res = await runRegistryHealthCheck();
    expect(res.baseline).toBe(true);
    expect(res.regressions).toEqual([]);
    expect(RegistryHealthSnapshot.create).toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('an increase notifies every admin and re-baselines', async () => {
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({
      metrics: { nameCheckFlags: 0, canonicalCollisionSets: 2, lowConfidenceQueue: 5,
        producerSpellingSplits: 0, missingInvariants: 0, pendingWineReports: 0, pendingWineRequests: 0 },
    }));
    WineDefinition.aggregate.mockResolvedValue([{ sets: 4 }]); // 2 → 4
    User.find.mockReturnValue(leanChain([{ _id: 'a1' }, { _id: 'a2' }]));

    const res = await runRegistryHealthCheck();
    expect(res.regressions).toEqual(['canonical-key collision sets: 2 → 4']);
    expect(res.notified).toBe(2);
    expect(createNotification).toHaveBeenCalledWith(
      'a1', 'registry_health', expect.any(String),
      expect.stringContaining('2 → 4'), '/admin/wines');
    // Re-baseline happens regardless, so this alert cannot repeat next week.
    expect(RegistryHealthSnapshot.create).toHaveBeenCalledWith({ metrics: expect.objectContaining({ canonicalCollisionSets: 4 }) });
  });

  test('steady or improving metrics stay silent', async () => {
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({
      metrics: { nameCheckFlags: 3, canonicalCollisionSets: 9, lowConfidenceQueue: 90,
        producerSpellingSplits: 85, missingInvariants: 2, pendingWineReports: 1, pendingWineRequests: 1 },
    }));
    const res = await runRegistryHealthCheck(); // everything computes to 0
    expect(res.regressions).toEqual([]);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a metric missing from the baseline skips a cycle instead of alerting on undefined', async () => {
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({ metrics: { nameCheckFlags: 0 } }));
    WineReport.countDocuments.mockResolvedValue(7); // no baseline for this key
    const res = await runRegistryHealthCheck();
    expect(res.regressions).toEqual([]);
  });

  test('the NEW cross-field metrics ride the same contract: silent on first appearance, alerting on later increase', async () => {
    const key = crossFieldMetricKey('producer-is-appellation.v1');
    // First run after deploy: the baseline predates the metric → skip a cycle
    // (this is the "new keys appear once" behaviour the prod watchdog mirrors).
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({
      metrics: { nameCheckFlags: 0, canonicalCollisionSets: 0, lowConfidenceQueue: 0,
        producerSpellingSplits: 0, missingInvariants: 0, pendingWineReports: 0, pendingWineRequests: 0 },
    }));
    scanCrossFieldChecks.mockResolvedValue({
      rows: [], total: 2, clearedCount: 0, scannedCount: 100,
      ruleCounts: { 'producer-is-appellation.v1': 2 },
    });
    let res = await runRegistryHealthCheck();
    expect(res.regressions).toEqual([]);

    // Next run: baselined at 2, now 5 → a named per-rule regression.
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({
      metrics: { nameCheckFlags: 0, canonicalCollisionSets: 0, lowConfidenceQueue: 0,
        producerSpellingSplits: 0, missingInvariants: 0, pendingWineReports: 0, pendingWineRequests: 0,
        [key]: 2 },
    }));
    scanCrossFieldChecks.mockResolvedValue({
      rows: [], total: 5, clearedCount: 0, scannedCount: 100,
      ruleCounts: { 'producer-is-appellation.v1': 5 },
    });
    res = await runRegistryHealthCheck();
    expect(res.regressions).toEqual(['cross-field flags (producer-is-appellation.v1): 2 → 5']);
    expect(createNotification).toHaveBeenCalled();
  });

  test('a notify failure is per-admin non-fatal', async () => {
    RegistryHealthSnapshot.findOne.mockReturnValue(leanChain({
      metrics: { pendingWineReports: 0, nameCheckFlags: 0, canonicalCollisionSets: 0,
        lowConfidenceQueue: 0, producerSpellingSplits: 0, missingInvariants: 0, pendingWineRequests: 0 },
    }));
    WineReport.countDocuments.mockResolvedValue(3);
    User.find.mockReturnValue(leanChain([{ _id: 'a1' }, { _id: 'a2' }]));
    createNotification.mockRejectedValueOnce(new Error('push down')).mockResolvedValue({});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runRegistryHealthCheck();
    expect(res.notified).toBe(1);
    warn.mockRestore();
  });
});
