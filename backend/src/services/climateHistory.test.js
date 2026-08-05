/**
 * Climate history aggregates for MCP climate_status (support ticket 6a71c6b2).
 *
 * WHY THIS TEST EXISTS:
 * The feature's promise is "13–17 °C across the year, no excursions" computed
 * INSIDE MongoDB — the pipelines must stay index-friendly and window-correct,
 * and the excursion math (gap-tolerant episode merging, window clipping,
 * span-based duration) is the part an off-by-one quietly corrupts: a wrong
 * boundary either invents excursions or hides a broken cooling unit.
 *
 * Mongo executes the pipelines in prod; here the builders are pinned
 * stage-by-stage (match windows, bounds, bucket size, caps) and the pure JS
 * halves (bucket→episode merge, per-window stats, shaping/rounding) are
 * exercised directly. The full pipelines were additionally validated against
 * a real mongo:7 time-series collection when this feature was built.
 */

jest.mock('../models/ClimateReading', () => ({ aggregate: jest.fn() }));

const ClimateReading = require('../models/ClimateReading');
const {
  WINDOWS,
  EXCURSION_ROW_CAP,
  gapMinutes,
  buildStatsPipeline,
  buildExcursionPipeline,
  mergeBucketRows,
  excursionStats,
  collectClimateHistory,
  formatHistoryCapsule,
  humanizeMinutes,
} = require('./climateHistory');

const NOW = new Date('2026-08-05T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const CFG = { tempMin: 8, tempMax: 16, rhMin: 45, rhMax: 80, offlineAfterMin: 60, alertsEnabled: true };
const DEV = 'd'.repeat(24);

/** Mongoose Aggregate stand-in: awaitable AND .allowDiskUse()-chainable. */
const aggResult = (rows) => {
  const p = Promise.resolve(rows);
  p.allowDiskUse = () => p;
  return p;
};

const bucketRow = (device, channel, type, bucketIso, firstIso, lastIso, readings) => ({
  _id: { device, channel, type, bucket: new Date(bucketIso) },
  firstTs: new Date(firstIso),
  lastTs: new Date(lastIso),
  readings,
});

beforeEach(() => jest.clearAllMocks());

describe('windows & gap tolerance', () => {
  test('the three ticket windows: 24h, 30d, 12m (365d)', () => {
    expect(WINDOWS.map((w) => w.key)).toEqual(['24h', '30d', '12m']);
    expect(WINDOWS.map((w) => w.ms)).toEqual([DAY, 30 * DAY, 365 * DAY]);
  });

  test('gapMinutes follows offlineAfterMin, defended to the schema range and integers', () => {
    expect(gapMinutes(CFG)).toBe(60);
    expect(gapMinutes({})).toBe(60);            // default when unset
    expect(gapMinutes({ offlineAfterMin: 5 })).toBe(15);     // schema floor
    expect(gapMinutes({ offlineAfterMin: 99999 })).toBe(1440); // schema ceiling
    expect(gapMinutes({ offlineAfterMin: 90.7 })).toBe(91);  // $dateTrunc needs an integer
  });
});

describe('buildStatsPipeline', () => {
  const pipeline = buildStatsPipeline({ deviceIds: [DEV], cfg: CFG, now: NOW });

  test('leads with the index-backed device+ts match over the full 12m window', () => {
    expect(pipeline[0]).toEqual({
      $match: { 'meta.device': { $in: [DEV] }, ts: { $gte: new Date(NOW.getTime() - 365 * DAY) } },
    });
  });

  test('out-of-range flag uses the cellar bounds per reading type', () => {
    expect(pipeline[1]).toEqual({
      $addFields: {
        out: {
          $cond: [
            { $eq: ['$meta.type', 'temperature'] },
            { $or: [{ $lt: ['$value', 8] }, { $gt: ['$value', 16] }] },
            { $or: [{ $lt: ['$value', 45] }, { $gt: ['$value', 80] }] },
          ],
        },
      },
    });
  });

  test('one $group per type computes all three windows: 12m unconditional, inner windows gated on inclusive ts >= since', () => {
    const group = pipeline[2].$group;
    expect(group._id).toBe('$meta.type');
    // 12m accumulators see every matched reading.
    expect(group.min_12m).toEqual({ $min: '$value' });
    expect(group.readings_12m).toEqual({ $sum: 1 });
    expect(group.out_12m).toEqual({ $sum: { $cond: ['$out', 1, 0] } });
    // Inner windows contribute null/0 outside their boundary — $min/$max/$avg
    // ignore nulls, which is what makes the single pass correct.
    const since24h = new Date(NOW.getTime() - DAY);
    const since30d = new Date(NOW.getTime() - 30 * DAY);
    expect(group.min_24h).toEqual({ $min: { $cond: [{ $gte: ['$ts', since24h] }, '$value', null] } });
    expect(group.mean_30d).toEqual({ $avg: { $cond: [{ $gte: ['$ts', since30d] }, '$value', null] } });
    expect(group.readings_24h).toEqual({ $sum: { $cond: [{ $gte: ['$ts', since24h] }, 1, 0] } });
    expect(group.out_30d).toEqual({ $sum: { $cond: [{ $gte: ['$ts', since30d] }, { $cond: ['$out', 1, 0] }, 0] } });
  });
});

describe('buildExcursionPipeline', () => {
  const pipeline = buildExcursionPipeline({ deviceIds: [DEV], cfg: CFG, now: NOW });

  test('matches only out-of-range readings, still leading with device+ts for the index', () => {
    expect(pipeline[0]).toEqual({
      $match: {
        'meta.device': { $in: [DEV] },
        ts: { $gte: new Date(NOW.getTime() - 365 * DAY) },
        $or: [
          { 'meta.type': 'temperature', $or: [{ value: { $lt: 8 } }, { value: { $gt: 16 } }] },
          { 'meta.type': 'humidity', $or: [{ value: { $lt: 45 } }, { value: { $gt: 80 } }] },
        ],
      },
    });
  });

  test('buckets per (device, channel, type) at exactly the gap tolerance, sorted for the linear merge, capped', () => {
    const group = pipeline[1].$group;
    expect(group._id.bucket).toEqual({ $dateTrunc: { date: '$ts', unit: 'minute', binSize: 60 } });
    expect(group._id.device).toBe('$meta.device');
    expect(group.firstTs).toEqual({ $min: '$ts' });
    expect(group.lastTs).toEqual({ $max: '$ts' });
    expect(pipeline[2]).toEqual({ $sort: { '_id.device': 1, '_id.channel': 1, '_id.type': 1, '_id.bucket': 1 } });
    expect(pipeline[3]).toEqual({ $limit: EXCURSION_ROW_CAP });
  });

  test('bucket size follows the cellar offlineAfterMin', () => {
    const p = buildExcursionPipeline({ deviceIds: [DEV], cfg: { ...CFG, offlineAfterMin: 30 }, now: NOW });
    expect(p[1].$group._id.bucket.$dateTrunc.binSize).toBe(30);
  });
});

describe('mergeBucketRows — gap-tolerant episode detection', () => {
  const GAP_MS = 60 * 60 * 1000;

  test('adjacent buckets within the gap merge into one episode (spans + readings combine)', () => {
    const runs = mergeBucketRows([
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 11),
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T11:00:00Z', '2026-07-26T11:05:00Z', '2026-07-26T11:45:00Z', 9),
    ], GAP_MS);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      type: 'temperature',
      firstTs: new Date('2026-07-26T10:05:00Z').getTime(),
      lastTs: new Date('2026-07-26T11:45:00Z').getTime(),
      readings: 20,
    });
  });

  test('a silence longer than the gap splits episodes; exactly the gap still merges', () => {
    const split = mergeBucketRows([
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:00:00Z', '2026-07-26T10:30:00Z', 7),
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T11:00:00Z', '2026-07-26T11:31:00Z', '2026-07-26T11:55:00Z', 2), // 61 min after 10:30
    ], GAP_MS);
    expect(split).toHaveLength(2);

    const merged = mergeBucketRows([
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:00:00Z', '2026-07-26T10:30:00Z', 7),
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T11:00:00Z', '2026-07-26T11:30:00Z', '2026-07-26T11:59:00Z', 2),
    ], GAP_MS); // exactly 60 min after 10:30 → same episode
    expect(merged).toHaveLength(1);
    expect(merged[0].readings).toBe(9);
  });

  test('a partition change (other channel, type, or device) always starts a new episode, even at identical timestamps', () => {
    const rows = [
      bucketRow(DEV, 'ambient', 'humidity', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 3),
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 3),
      bucketRow(DEV, 'crate', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 3),
      bucketRow('e'.repeat(24), 'crate', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 3),
    ];
    expect(mergeBucketRows(rows, GAP_MS)).toHaveLength(4);
  });

  test('a single out-of-range reading is a zero-span episode', () => {
    const runs = mergeBucketRows([
      bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:12:00Z', '2026-07-26T10:12:00Z', 1),
    ], GAP_MS);
    expect(runs).toHaveLength(1);
    expect(runs[0].lastTs - runs[0].firstTs).toBe(0);
  });

  test('empty input → no episodes', () => {
    expect(mergeBucketRows([], GAP_MS)).toEqual([]);
  });
});

describe('excursionStats — window overlap + duration clipping', () => {
  const run = (type, firstIso, lastIso) => ({
    type, firstTs: new Date(firstIso).getTime(), lastTs: new Date(lastIso).getTime(), readings: 1,
  });
  const since = new Date('2026-08-04T12:00:00Z').getTime(); // 24h window start

  test('episodes ending before the window are excluded; ending exactly at the boundary counts (inclusive)', () => {
    const runs = [
      run('temperature', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'), // out
      run('temperature', '2026-08-04T11:00:00Z', '2026-08-04T12:00:00Z'), // lastTs == since
    ];
    const s = excursionStats(runs, 'temperature', since);
    expect(s.excursions).toBe(1);
    expect(s.longestMs).toBe(0); // clipped: max(firstTs, since) == since == lastTs
  });

  test('an episode straddling the window start is clipped to the window', () => {
    const runs = [run('temperature', '2026-08-04T10:00:00Z', '2026-08-04T14:00:00Z')];
    const s = excursionStats(runs, 'temperature', since);
    expect(s.excursions).toBe(1);
    expect(s.longestMs).toBe(2 * 3600 * 1000); // 12:00 → 14:00, not the full 4h
  });

  test('fully inside → full span; other types are invisible', () => {
    const runs = [
      run('temperature', '2026-08-04T20:00:00Z', '2026-08-04T21:30:00Z'),
      run('humidity', '2026-08-04T20:00:00Z', '2026-08-05T02:00:00Z'),
    ];
    const s = excursionStats(runs, 'temperature', since);
    expect(s.excursions).toBe(1);
    expect(s.longestMs).toBe(90 * 60 * 1000);
    expect(excursionStats(runs, 'humidity', since).longestMs).toBe(6 * 3600 * 1000);
  });

  test('longest picks the maximum across episodes', () => {
    const runs = [
      run('temperature', '2026-08-04T13:00:00Z', '2026-08-04T13:20:00Z'),
      run('temperature', '2026-08-04T18:00:00Z', '2026-08-04T19:40:00Z'),
    ];
    const s = excursionStats(runs, 'temperature', since);
    expect(s.excursions).toBe(2);
    expect(s.longestMs).toBe(100 * 60 * 1000);
  });
});

describe('collectClimateHistory — end to end over mocked aggregation rows', () => {
  const statsTemp = {
    _id: 'temperature',
    readings_24h: 288, out_24h: 0, min_24h: 12.14, max_24h: 13.92, mean_24h: 12.876,
    readings_30d: 8640, out_30d: 20, min_30d: 11.5, max_30d: 17.4, mean_30d: 13.04,
    readings_12m: 100000, out_12m: 21, min_12m: 10.2, max_12m: 18.31, mean_12m: 12.955,
  };
  const statsRh = {
    _id: 'humidity',
    readings_24h: 288, out_24h: 0, min_24h: 55, max_24h: 66.46, mean_24h: 60.1,
    readings_30d: 8640, out_30d: 0, min_30d: 52, max_30d: 71, mean_30d: 61.2,
    readings_12m: 100000, out_12m: 0, min_12m: 50.04, max_12m: 74, mean_12m: 60.9,
  };
  // Two temperature episodes: a 100-minute one 10 days ago (two merging
  // buckets) and a momentary spike 200 days ago.
  const buckets = [
    bucketRow(DEV, 'ambient', 'temperature', '2026-01-17T10:00:00Z', '2026-01-17T10:12:00Z', '2026-01-17T10:12:00Z', 1),
    bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T10:00:00Z', '2026-07-26T10:05:00Z', '2026-07-26T10:55:00Z', 11),
    bucketRow(DEV, 'ambient', 'temperature', '2026-07-26T11:00:00Z', '2026-07-26T11:05:00Z', '2026-07-26T11:45:00Z', 9),
  ];

  test('shapes both types with rounded values, per-window excursion counts and clipped durations', async () => {
    ClimateReading.aggregate
      .mockReturnValueOnce(aggResult([statsTemp, statsRh]))
      .mockReturnValueOnce(aggResult(buckets));

    const { history, warnings } = await collectClimateHistory({ deviceIds: [DEV], cfg: CFG, now: NOW });
    expect(warnings).toEqual([]);

    expect(history.temperature.unit).toBe('°C');
    expect(history.temperature['24h']).toEqual({
      readings: 288, min: 12.1, max: 13.9, mean: 12.9, out_of_range: 0,
      excursions: 0, longest_excursion_minutes: null,
    });
    expect(history.temperature['30d']).toEqual({
      readings: 8640, min: 11.5, max: 17.4, mean: 13, out_of_range: 20,
      excursions: 1, longest_excursion_minutes: 100,
    });
    expect(history.temperature['12m']).toEqual({
      readings: 100000, min: 10.2, max: 18.3, mean: 13, out_of_range: 21,
      excursions: 2, longest_excursion_minutes: 100, // the spike adds a count, not a duration
    });

    expect(history.humidity.unit).toBe('%');
    expect(history.humidity['12m']).toMatchObject({ min: 50, max: 74, excursions: 0, longest_excursion_minutes: null });

    // Both aggregations ran against the device set with the index-shaped match.
    const [statsPipeline] = ClimateReading.aggregate.mock.calls[0];
    const [excursionPipeline] = ClimateReading.aggregate.mock.calls[1];
    expect(statsPipeline[0].$match['meta.device']).toEqual({ $in: [DEV] });
    expect(excursionPipeline[0].$match.ts).toEqual({ $gte: new Date(NOW.getTime() - 365 * DAY) });
  });

  test('a type with no readings serializes as null, not an empty shell', async () => {
    ClimateReading.aggregate
      .mockReturnValueOnce(aggResult([statsTemp]))
      .mockReturnValueOnce(aggResult([]));
    const { history } = await collectClimateHistory({ deviceIds: [DEV], cfg: CFG, now: NOW });
    expect(history.humidity).toBeNull();
    expect(history.temperature['12m'].excursions).toBe(0);
  });

  test('no readings at all in 12m → history null with an explanatory warning', async () => {
    ClimateReading.aggregate
      .mockReturnValueOnce(aggResult([]))
      .mockReturnValueOnce(aggResult([]));
    const { history, warnings } = await collectClimateHistory({ deviceIds: [DEV], cfg: CFG, now: NOW });
    expect(history).toBeNull();
    expect(warnings.join(' ')).toMatch(/No readings stored in the last 12 months/);
  });

  test('no devices → null history without touching the readings collection', async () => {
    const { history, warnings } = await collectClimateHistory({ deviceIds: [], cfg: CFG, now: NOW });
    expect(history).toBeNull();
    expect(warnings).toEqual([]);
    expect(ClimateReading.aggregate).not.toHaveBeenCalled();
  });

  test('an excursion sequence past the row cap degrades to null excursion fields plus a warning — never a wrong count', async () => {
    const flood = Array.from({ length: EXCURSION_ROW_CAP }, (_, i) =>
      bucketRow(DEV, 'ambient', 'temperature', new Date(NOW.getTime() - i * 3600 * 1000).toISOString(),
        new Date(NOW.getTime() - i * 3600 * 1000).toISOString(), new Date(NOW.getTime() - i * 3600 * 1000).toISOString(), 4));
    ClimateReading.aggregate
      .mockReturnValueOnce(aggResult([statsTemp]))
      .mockReturnValueOnce(aggResult(flood));
    const { history, warnings } = await collectClimateHistory({ deviceIds: [DEV], cfg: CFG, now: NOW });
    expect(history.temperature['12m'].excursions).toBeNull();
    expect(history.temperature['12m'].longest_excursion_minutes).toBeNull();
    expect(history.temperature['12m'].min).toBe(10.2); // stats still present
    expect(warnings.join(' ')).toMatch(/excursion/i);
  });
});

describe('summary capsule', () => {
  const win = (over = {}) => ({
    readings: 1000, min: 12.1, max: 13.9, mean: 12.9, out_of_range: 0,
    excursions: 0, longest_excursion_minutes: null, ...over,
  });
  const hist = (t12, h12) => ({
    temperature: t12 ? { unit: '°C', '12m': t12 } : null,
    humidity: h12 ? { unit: '%', '12m': h12 } : null,
  });

  test('reads like the ticket asked: range capsule + excursion verdict', () => {
    expect(formatHistoryCapsule(hist(win(), win({ min: 55, max: 71 }))))
      .toBe('12m: 12.1–13.9 °C, 55–71% RH, no excursions');
    expect(formatHistoryCapsule(hist(win({ excursions: 2, longest_excursion_minutes: 210 }), null)))
      .toBe('12m: 12.1–13.9 °C, 2 excursion(s), longest 3.5 h');
  });

  test('momentary-spike-only episodes claim a count but no duration', () => {
    expect(formatHistoryCapsule(hist(win({ excursions: 1, longest_excursion_minutes: null }), null)))
      .toBe('12m: 12.1–13.9 °C, 1 excursion(s)');
  });

  test('truncated excursion data stays silent about excursions instead of claiming zero', () => {
    expect(formatHistoryCapsule(hist(win({ excursions: null }), win({ min: 55, max: 71, excursions: null }))))
      .toBe('12m: 12.1–13.9 °C, 55–71% RH');
  });

  test('null / empty history → null', () => {
    expect(formatHistoryCapsule(null)).toBeNull();
    expect(formatHistoryCapsule({ temperature: null, humidity: null })).toBeNull();
  });

  test('humanizeMinutes picks sane units', () => {
    expect(humanizeMinutes(45)).toBe('45 min');
    expect(humanizeMinutes(119)).toBe('119 min');
    expect(humanizeMinutes(210)).toBe('3.5 h');
    expect(humanizeMinutes(1440)).toBe('24 h');
    expect(humanizeMinutes(4320)).toBe('3 d');
  });
});
