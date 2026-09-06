/**
 * Daily registry readers report (registry lockdown 2026-09-06, layer L4).
 *
 * Yesterday's RegistryReadDay rows, ranked by DISTINCT wines read. A copy of
 * the registry is a reader with thousands of distinct wines in a day; a
 * person has tens. The report goes to admins as one in-app notification when
 * any reader passed the alert level, and is always logged so the numbers are
 * in the container log even on a quiet day. Anonymous readers past the hard
 * cap were already refused in real time (registryReadTracker); this catches
 * members and crawlers, which are counted but never refused.
 */
const RegistryReadDay = require('../models/RegistryReadDay');
const User = require('../models/User');
const { createNotifications } = require('./notifications');
const { limits, dayKey } = require('./registryReadTracker');

const TOP_N = 10;

/** Top readers for one day, distinct-wines descending. */
async function topReaders(day, n = TOP_N) {
  const rows = await RegistryReadDay.aggregate([
    { $match: { day } },
    { $project: { readerKey: 1, kind: 1, count: 1, blockedAt: 1, distinct: { $size: { $ifNull: ['$wines', []] } } } },
    { $sort: { distinct: -1, count: -1 } },
    { $limit: n },
  ]);
  return rows.map((r) => ({ readerKey: r.readerKey, kind: r.kind, distinct: r.distinct, reads: r.count, blocked: !!r.blockedAt }));
}

function yesterday() {
  return dayKey(new Date(Date.now() - 86400e3));
}

/**
 * @param {string} [day] YYYY-MM-DD (UTC); defaults to yesterday.
 * @returns {Promise<{day:string, readers:Array, alerted:Array}>}
 */
async function runRegistryReadReport(day = yesterday()) {
  const { anonymousDailyDistinct, memberAlertDistinct } = limits();
  const readers = await topReaders(day);
  const alerted = readers.filter((r) => (r.kind === 'ip' ? r.distinct > anonymousDailyDistinct : r.distinct > memberAlertDistinct));

  const line = (r) => `${r.readerKey} (${r.kind}) ${r.distinct} distinct wines, ${r.reads} reads${r.blocked ? ', refused' : ''}`;
  console.log(`[registryRead] ${day}: top readers — ${readers.length ? readers.map(line).join('; ') : 'none'}`);

  if (alerted.length) {
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    const title = `Registry readers ${day}: ${alerted.length} past the alert level`;
    const message = alerted.map(line).join('\n');
    await createNotifications(admins.map((a) => ({
      userId: a._id, type: 'registry_read_alert', title, message, link: null,
    })));
  }
  return { day, readers, alerted };
}

module.exports = { runRegistryReadReport, topReaders };
