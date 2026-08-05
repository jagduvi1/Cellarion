const ClimateReading = require('../models/ClimateReading');
const { boundsFor } = require('./climateAlerts');

// Climate history aggregates for the MCP climate_status tool (support ticket
// 6a71c6b2): per reading type (temperature/humidity), min/max/mean plus
// excursion episodes over three windows — 24h / 30d / 12m — so a chat answer
// can read "13–17 °C across the year, no excursions" without the model ever
// seeing raw readings.
//
// Everything heavy runs INSIDE MongoDB against the ClimateReading time-series
// collection (a device-year is ~420k rows at 5-min cadence — never loaded into
// JS). Both pipelines lead with a $match on { 'meta.device', ts } so they ride
// the secondary { 'meta.device': 1, ts: 1 } index the model defines for
// exactly this access pattern (the auto-created whole-metaField index cannot
// serve dotted meta.device predicates — see models/ClimateReading.js).
//
// Two aggregations, both O(1)-bounded output:
//
// 1. STATS — one pass over the 12m window. Because the windows nest
//    (24h ⊂ 30d ⊂ 12m), one $group per reading type computes all three
//    windows via conditional accumulators ($min/$max/$avg ignore the nulls
//    that out-of-window readings contribute). Output: ≤ 2 rows.
//
// 2. EXCURSIONS — out-of-range readings only (an index-backed $match with the
//    bounds as residual filter — in the healthy case this matches ~nothing),
//    collapsed per (device, channel, type) into fixed time buckets of exactly
//    the gap tolerance, keeping first/last ts + count per bucket. The bucket
//    width IS the gap tolerance, which makes the reduction lossless for run
//    detection: two readings in the same bucket can never be more than one
//    bucket width apart, so they always belong to the same episode; episodes
//    can therefore only split BETWEEN buckets, exactly where
//    next.firstTs − prev.lastTs > gap. JS then merges the (bounded) bucket
//    rows into episodes with a linear pass.
//
// Excursion semantics (deliberate, documented for whoever tunes them):
// - Gap tolerance = the cellar's offlineAfterMin — the same "sensor is still
//   reporting continuously" horizon climateAlerts uses to declare a channel
//   stale and climateOfflineJob uses to declare a device offline. A silence
//   longer than that splits episodes: we will not claim the cellar was out of
//   range while the sensor was blind.
// - Episodes are counted per sensor channel, then rolled up per reading type,
//   so two probes both alarming during one warm week count as two episodes of
//   that week — each sensor's evidence stands on its own.
// - An in-range dip SHORTER than the gap tolerance does not end an episode
//   (out-of-range-only matching never sees it). That is intentional hysteresis
//   in the spirit of climateAlerts' SUSTAIN_MS: a thermostat oscillating on
//   the boundary is ONE excursion in a 12-month summary, not hundreds.
// - Duration = span from first to last out-of-range reading of the episode,
//   clipped to the window. A single-reading episode spans 0 minutes — it is
//   still counted (a momentary spike), it just claims no duration, because at
//   an unknown cadence any padding would be invented data.
// - A window counts an episode when any of its readings fall inside (episodes
//   straddling the window start are clipped, so counts are monotone across
//   the nested windows).

const WINDOWS = [
  { key: '24h', ms: 24 * 3600 * 1000 },
  { key: '30d', ms: 30 * 24 * 3600 * 1000 },
  { key: '12m', ms: 365 * 24 * 3600 * 1000 },
];

// Hard ceiling on excursion bucket rows pulled into JS. Only reachable when a
// cellar is out of range for partition-YEARS (e.g. one channel needs ~8.7k
// buckets for a fully-breached year at the default 60-min gap, ~35k at the
// 15-min minimum). Beyond the cap the episode math would be built on a
// truncated sequence, so excursion fields degrade to null with a warning —
// min/max/mean and the out-of-range reading counts (from the stats pass)
// still tell the story of a cellar that broken.
const EXCURSION_ROW_CAP = 50000;

/** Gap tolerance in whole minutes: the cellar's offlineAfterMin, defended
 * against a non-integer or out-of-schema value ($dateTrunc binSize must be a
 * positive integer; the Cellar schema bounds are 15–1440). */
function gapMinutes(cfg) {
  const raw = Number(cfg && cfg.offlineAfterMin);
  if (!Number.isFinite(raw)) return 60;
  return Math.min(1440, Math.max(15, Math.round(raw)));
}

/** Aggregation boolean: is this reading outside its type's bounds? */
function outOfRangeExpr(cfg) {
  const t = boundsFor('temperature', cfg);
  const h = boundsFor('humidity', cfg);
  return {
    $cond: [
      { $eq: ['$meta.type', 'temperature'] },
      { $or: [{ $lt: ['$value', t.min] }, { $gt: ['$value', t.max] }] },
      { $or: [{ $lt: ['$value', h.min] }, { $gt: ['$value', h.max] }] },
    ],
  };
}

/** since-Date per window key, all relative to one `now`. */
function windowStarts(now) {
  const t = now.getTime();
  const starts = {};
  for (const w of WINDOWS) starts[w.key] = new Date(t - w.ms);
  return starts;
}

/**
 * Pipeline 1: per-type min/max/mean + reading/out-of-range counts for all
 * three windows in a single index-backed pass over the 12m window.
 */
function buildStatsPipeline({ deviceIds, cfg, now }) {
  const since = windowStarts(now);
  // 12m is the outer $match, so its accumulators are unconditional; the inner
  // windows wrap each accumulated expression in an inclusive ts >= since cond.
  const winExpr = (key, expr, otherwise) =>
    (key === '12m' ? expr : { $cond: [{ $gte: ['$ts', since[key]] }, expr, otherwise] });
  const group = { _id: '$meta.type' };
  for (const { key } of WINDOWS) {
    group[`readings_${key}`] = { $sum: winExpr(key, 1, 0) };
    group[`out_${key}`] = { $sum: winExpr(key, { $cond: ['$out', 1, 0] }, 0) };
    group[`min_${key}`] = { $min: winExpr(key, '$value', null) };
    group[`max_${key}`] = { $max: winExpr(key, '$value', null) };
    group[`mean_${key}`] = { $avg: winExpr(key, '$value', null) };
  }
  return [
    { $match: { 'meta.device': { $in: deviceIds }, ts: { $gte: since['12m'] } } },
    { $addFields: { out: outOfRangeExpr(cfg) } },
    { $group: group },
  ];
}

/**
 * Pipeline 2: out-of-range readings collapsed into gap-width buckets per
 * (device, channel, type) — the lossless reduction mergeBucketRows() turns
 * into excursion episodes. Sorted so the JS merge is a single linear pass;
 * $sort+$limit lets Mongo run a bounded top-k instead of a full sort.
 */
function buildExcursionPipeline({ deviceIds, cfg, now }) {
  const since = windowStarts(now);
  const t = boundsFor('temperature', cfg);
  const h = boundsFor('humidity', cfg);
  return [
    {
      $match: {
        'meta.device': { $in: deviceIds },
        ts: { $gte: since['12m'] },
        $or: [
          { 'meta.type': 'temperature', $or: [{ value: { $lt: t.min } }, { value: { $gt: t.max } }] },
          { 'meta.type': 'humidity', $or: [{ value: { $lt: h.min } }, { value: { $gt: h.max } }] },
        ],
      },
    },
    {
      $group: {
        _id: {
          device: '$meta.device',
          channel: '$meta.channel',
          type: '$meta.type',
          bucket: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: gapMinutes(cfg) } },
        },
        firstTs: { $min: '$ts' },
        lastTs: { $max: '$ts' },
        readings: { $sum: 1 },
      },
    },
    { $sort: { '_id.device': 1, '_id.channel': 1, '_id.type': 1, '_id.bucket': 1 } },
    { $limit: EXCURSION_ROW_CAP },
  ];
}

/**
 * Merge sorted bucket rows into excursion episodes. Same-partition buckets
 * whose inter-reading silence is within gapMs continue the episode; a longer
 * silence — or a partition change — starts a new one.
 * Returns [{ type, firstTs, lastTs, readings }] with ts as epoch ms.
 */
function mergeBucketRows(rows, gapMs) {
  const runs = [];
  let cur = null;
  let curPart = null;
  for (const row of rows) {
    const part = `${row._id.device} ${row._id.channel} ${row._id.type}`;
    const firstTs = new Date(row.firstTs).getTime();
    const lastTs = new Date(row.lastTs).getTime();
    if (cur && part === curPart && firstTs - cur.lastTs <= gapMs) {
      cur.lastTs = Math.max(cur.lastTs, lastTs);
      cur.readings += row.readings;
    } else {
      cur = { type: row._id.type, firstTs, lastTs, readings: row.readings };
      curPart = part;
      runs.push(cur);
    }
  }
  return runs;
}

/**
 * Episode count + longest window-clipped duration for one type/window.
 * An episode overlaps the window iff its last out-of-range reading is at or
 * after the window start (episodes never extend past `now`).
 */
function excursionStats(runs, type, sinceMs) {
  let excursions = 0;
  let longestMs = 0;
  for (const run of runs) {
    if (run.type !== type || run.lastTs < sinceMs) continue;
    excursions += 1;
    longestMs = Math.max(longestMs, run.lastTs - Math.max(run.firstTs, sinceMs));
  }
  return { excursions, longestMs };
}

const round1 = (v) => (v == null ? null : Number(Number(v).toFixed(1)));

/** One reading type's { unit, '24h': {...}, '30d': {...}, '12m': {...} }. */
function shapeType(statsRow, runs, cfg, now) {
  if (!statsRow || !statsRow.readings_12m) return null;
  const since = windowStarts(now);
  const shaped = { unit: boundsFor(statsRow._id, cfg).unit };
  for (const { key } of WINDOWS) {
    const entry = {
      readings: statsRow[`readings_${key}`] || 0,
      min: round1(statsRow[`min_${key}`]),
      max: round1(statsRow[`max_${key}`]),
      mean: round1(statsRow[`mean_${key}`]),
      out_of_range: statsRow[`out_${key}`] || 0,
    };
    if (runs === null) {
      // Excursion sequence overflowed EXCURSION_ROW_CAP — counting on a
      // truncated sequence would be wrong, so say "unknown", not a number.
      entry.excursions = null;
      entry.longest_excursion_minutes = null;
    } else {
      const { excursions, longestMs } = excursionStats(runs, statsRow._id, since[key].getTime());
      entry.excursions = excursions;
      entry.longest_excursion_minutes = excursions > 0 ? Math.round(longestMs / 60000) : null;
    }
    shaped[key] = entry;
  }
  return shaped;
}

/**
 * The whole feature: both aggregations + shaping.
 * Returns { history, warnings } where history is null when the devices have
 * no readings in the last 12 months, and each present type carries the three
 * windows. Callers pass cfg from effectiveClimateConfig().
 */
async function collectClimateHistory({ deviceIds, cfg, now = new Date() }) {
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return { history: null, warnings: [] };
  }
  const [statsRows, bucketRows] = await Promise.all([
    ClimateReading.aggregate(buildStatsPipeline({ deviceIds, cfg, now })),
    // allowDiskUse: the bucket $group's hash state is per-bucket and only
    // pathological all-year-out-of-range data grows it past the 100MB
    // in-memory stage limit — spill instead of erroring the tool call.
    ClimateReading.aggregate(buildExcursionPipeline({ deviceIds, cfg, now })).allowDiskUse(true),
  ]);

  const warnings = [];
  const truncated = bucketRows.length >= EXCURSION_ROW_CAP;
  const runs = truncated ? null : mergeBucketRows(bucketRows, gapMinutes(cfg) * 60 * 1000);
  if (truncated) {
    warnings.push('Too many out-of-range readings in the last 12 months to count excursion episodes — excursion fields are null; the out_of_range totals still show the scale.');
  }

  const byType = new Map(statsRows.map((r) => [r._id, r]));
  const history = {
    temperature: shapeType(byType.get('temperature'), runs, cfg, now),
    humidity: shapeType(byType.get('humidity'), runs, cfg, now),
  };
  if (!history.temperature && !history.humidity) {
    return { history: null, warnings: ['No readings stored in the last 12 months — history aggregates are unavailable.'] };
  }
  return { history, warnings };
}

/** "45 min" / "3.5 h" / "2.1 d" for the summary capsule. */
function humanizeMinutes(minutes) {
  if (minutes < 120) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Number((minutes / 60).toFixed(1))} h`;
  return `${Number((minutes / 1440).toFixed(1))} d`;
}

/**
 * Compact 12-month capsule for the tool summary line, e.g.
 * "12m: 12.1–13.9 °C, 55–71% RH, no excursions" — the shape the support
 * ticket asked answers to read like. Null when there is nothing to say.
 */
function formatHistoryCapsule(history) {
  if (!history) return null;
  const parts = [];
  const t = history.temperature && history.temperature['12m'];
  const h = history.humidity && history.humidity['12m'];
  if (t && t.readings > 0) parts.push(`${t.min}–${t.max} °C`);
  if (h && h.readings > 0) parts.push(`${h.min}–${h.max}% RH`);
  if (parts.length === 0) return null;
  const counts = [t, h].filter((w) => w && w.excursions != null);
  if (counts.length === [t, h].filter(Boolean).length) { // no truncation → speak to excursions
    const total = counts.reduce((sum, w) => sum + w.excursions, 0);
    if (total === 0) {
      parts.push('no excursions');
    } else {
      const longest = Math.max(...counts.map((w) => w.longest_excursion_minutes || 0));
      parts.push(`${total} excursion(s)${longest > 0 ? `, longest ${humanizeMinutes(longest)}` : ''}`);
    }
  }
  return `12m: ${parts.join(', ')}`;
}

module.exports = {
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
};
