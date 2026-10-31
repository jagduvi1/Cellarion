/**
 * One-time backfill: fill User.lastActiveAt for accounts that have not been
 * seen since the field was added, from the evidence that still exists.
 *
 * The latest of, per account:
 *   • the day it was created
 *   • its device sessions' lastUsedAt (renewed every ~15 minutes of use; a
 *     session lives at most 30 days, so this reaches back about a month)
 *   • its own activity-log rows (actor) and its sign-ins (resource), within
 *     the log's retention (AUDIT_TTL_DAYS, 90 by default)
 *   • its API tokens' lastUsedAt (kept for as long as the token exists, so an
 *     integration's last day survives the activity log)
 *   • its Cellar Chat days
 * stored as UTC midnight of that day, as services/lastActive writes it.
 *
 * Only rows still without a value are written (`lastActiveAt: null` in the
 * filter), so a live write since the read is never overwritten, and a re-run
 * after an apply finds nothing to do.
 *
 *   node src/scripts/backfill-last-active.js           # dry run: counts only
 *   node src/scripts/backfill-last-active.js --apply   # write
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiToken = require('../models/ApiToken');
const ChatUsage = require('../models/ChatUsage');
const { activeDay } = require('../services/lastActive');

const SIGN_IN_ACTIONS = ['auth.login.success', 'auth.oauth.success'];
const DAY_MS = 24 * 60 * 60 * 1000;
const WRITE_BATCH = 500;
const READ_CHUNK = 1000;

// Latest evidence per user id (string) from one aggregation's { _id, at } rows.
function mergeLatest(latest, rows) {
  for (const r of rows) {
    if (!r || !r._id || !r.at) continue;
    const id = String(r._id);
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime())) continue;
    if (!latest.has(id) || latest.get(id) < at) latest.set(id, at);
  }
}

/**
 * @param {Array<{ _id, createdAt?, sessions? }>} users  accounts still without lastActiveAt
 * @returns {Promise<Map<string, Date>>} user id → the day to store
 */
async function lastActiveDays(users) {
  const latest = new Map();
  mergeLatest(latest, users.map((u) => ({ _id: u._id, at: u.createdAt })));
  mergeLatest(latest, users.flatMap((u) => (u.sessions || []).map((s) => ({ _id: u._id, at: s.lastUsedAt }))));

  const ids = users.map((u) => u._id);
  const [acted, signedIn, tokens, chats] = await Promise.all([
    AuditLog.aggregate([
      { $match: { 'actor.userId': { $in: ids } } },
      { $group: { _id: '$actor.userId', at: { $max: '$timestamp' } } },
    ]),
    AuditLog.aggregate([
      { $match: { action: { $in: SIGN_IN_ACTIONS }, 'resource.id': { $in: ids } } },
      { $group: { _id: '$resource.id', at: { $max: '$timestamp' } } },
    ]),
    ApiToken.aggregate([
      { $match: { user: { $in: ids }, lastUsedAt: { $ne: null } } },
      { $group: { _id: '$user', at: { $max: '$lastUsedAt' } } },
    ]),
    ChatUsage.aggregate([
      { $match: { userId: { $in: ids } } },
      // date is 'YYYY-MM-DD' (UTC); the string maximum is the latest day.
      { $group: { _id: '$userId', day: { $max: '$date' } } },
    ]),
  ]);
  mergeLatest(latest, acted);
  mergeLatest(latest, signedIn);
  mergeLatest(latest, tokens);
  mergeLatest(latest, chats.map((c) => ({ _id: c._id, at: c.day ? `${c.day}T00:00:00.000Z` : null })));

  const days = new Map();
  for (const [id, at] of latest) days.set(id, activeDay(at));
  return days;
}

/**
 * @returns {Promise<{ candidates: number, applied: number, byAge: Record<string, number> }>}
 *   byAge buckets the days found by how long ago they are, so a dry run shows
 *   what an inactive-account rule would see.
 */
async function backfillLastActive({ apply = false, now = () => new Date() } = {}) {
  const users = await User.find({ lastActiveAt: null }, '_id createdAt sessions.lastUsedAt').lean();
  const result = { candidates: users.length, applied: 0, byAge: { under30d: 0, '30-90d': 0, '90-180d': 0, '180-365d': 0, over365d: 0 } };
  if (users.length === 0) return result;

  // Evidence is gathered a chunk of accounts at a time, so the $in lists stay bounded.
  const days = new Map();
  for (let i = 0; i < users.length; i += READ_CHUNK) {
    for (const [id, day] of await lastActiveDays(users.slice(i, i + READ_CHUNK))) days.set(id, day);
  }
  const today = now().getTime();
  const ops = [];
  for (const [id, day] of days) {
    const age = (today - day.getTime()) / DAY_MS;
    const bucket = age < 30 ? 'under30d' : age < 90 ? '30-90d' : age < 180 ? '90-180d' : age < 365 ? '180-365d' : 'over365d';
    result.byAge[bucket]++;
    ops.push({ updateOne: { filter: { _id: id, lastActiveAt: null }, update: { $set: { lastActiveAt: day } } } });
  }
  if (apply) {
    for (let i = 0; i < ops.length; i += WRITE_BATCH) {
      const r = await User.bulkWrite(ops.slice(i, i + WRITE_BATCH), { ordered: false });
      result.applied += r.modifiedCount || 0;
    }
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (no changes; pass --apply to execute)'}`);

  const r = await backfillLastActive({ apply });
  console.log(`Accounts without lastActiveAt: ${r.candidates}`);
  console.log(`Last active, by how long ago: ${JSON.stringify(r.byAge)}`);
  if (apply) console.log(`Written: ${r.applied}`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backfillLastActive, lastActiveDays, mergeLatest, SIGN_IN_ACTIONS };
