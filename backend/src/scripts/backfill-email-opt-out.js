/**
 * One-time backfill (2026-09-27): record the objection of everyone who clicked
 * "unsubscribe from all Cellarion email" before User.emailOptOutAt existed.
 *
 * The one-click unsubscribe used to turn off only the notification flags the
 * account had stored at the time. Support answers are emailed since
 * 2026-09-26 (a new category, on by default), so an account that unsubscribed
 * earlier had no supportReply flag and would have been emailed anyway (audit
 * 2026-09-27 M7). utils/notifications.js now stamps emailOptOutAt and writes
 * every category; this does the same for the earlier clicks.
 *
 * Who: every actor of a `user.unsubscribe.all` audit entry (kept AUDIT_TTL_DAYS,
 * 90 by default — clicks older than that are not recoverable from the log).
 * With --all-off, also every account whose stored flags are ALL off: email and
 * push of every category present, including push, which defaults to on — a
 * state nobody reaches without meaning it.
 *
 * What: emailOptOutAt = the click's time (audit) or now (--all-off), and
 * supportReply.email = false so the settings page shows it off. Never touches
 * an account that already has emailOptOutAt, and never any other flag.
 *
 *   node src/scripts/backfill-email-opt-out.js                    # dry run: counts only
 *   node src/scripts/backfill-email-opt-out.js --apply            # audit-log clicks
 *   node src/scripts/backfill-email-opt-out.js --apply --all-off  # …and all-off accounts
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

/**
 * Accounts with a recorded unsubscribe-all click and no emailOptOutAt yet,
 * with the time of their FIRST click.
 * @returns {Promise<Array<{ userId: string, clickedAt: Date }>>}
 */
async function unsubscribersFromAuditLog() {
  const rows = await AuditLog.aggregate([
    { $match: { action: 'user.unsubscribe.all', 'actor.userId': { $ne: null } } },
    { $group: { _id: '$actor.userId', clickedAt: { $min: '$timestamp' } } },
  ]);
  if (rows.length === 0) return [];
  const pending = await User.find({ _id: { $in: rows.map((r) => r._id) }, emailOptOutAt: null }, '_id').lean();
  const pendingIds = new Set(pending.map((u) => String(u._id)));
  return rows
    .filter((r) => pendingIds.has(String(r._id)))
    .map((r) => ({ userId: String(r._id), clickedAt: r.clickedAt }));
}

// Every outbound flag the schema defined before support replies. All of them
// explicitly false — push defaults to on for the community categories, so an
// account cannot look like this by never touching its settings.
const ALL_OFF = {
  emailOptOutAt: null,
  'preferences.notifications.drinkWindow.email': false,
  'preferences.notifications.drinkWindow.push': false,
  'preferences.notifications.communityReply.email': false,
  'preferences.notifications.communityReply.push': false,
  'preferences.notifications.communityMention.email': false,
  'preferences.notifications.communityMention.push': false,
  'preferences.notifications.communityFollow.push': false,
};

/** Accounts whose stored flags are all off and that carry no emailOptOutAt. */
async function allOffAccounts() {
  const rows = await User.find(ALL_OFF, '_id').lean();
  return rows.map((u) => String(u._id));
}

const OPT_OUT_UPDATE = (at) => ({
  $set: { emailOptOutAt: at, 'preferences.notifications.supportReply.email': false },
});

/**
 * @returns {Promise<{ fromAuditLog: number, allOff: number, applied: number }>}
 */
async function backfillEmailOptOut({ apply = false, allOff = false, now = () => new Date() } = {}) {
  const clicks = await unsubscribersFromAuditLog();
  const result = { fromAuditLog: clicks.length, allOff: 0, applied: 0 };
  for (const { userId, clickedAt } of clicks) {
    // `emailOptOutAt: null` in the filter: never overwrite a stamp set since the read.
    if (apply) await User.updateOne({ _id: userId, emailOptOutAt: null }, OPT_OUT_UPDATE(clickedAt));
    result.applied++;
  }
  if (allOff) {
    const clicked = new Set(clicks.map((c) => c.userId));
    const ids = (await allOffAccounts()).filter((id) => !clicked.has(id));
    result.allOff = ids.length;
    for (const id of ids) {
      if (apply) await User.updateOne({ _id: id, emailOptOutAt: null }, OPT_OUT_UPDATE(now()));
      result.applied++;
    }
  }
  if (!apply) result.applied = 0;
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const allOff = process.argv.includes('--all-off');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (no changes; pass --apply to execute)'}`);

  const r = await backfillEmailOptOut({ apply, allOff });
  console.log(`Unsubscribe-all clicks in the audit log without emailOptOutAt: ${r.fromAuditLog}`);
  if (allOff) console.log(`Accounts with every stored flag off (not among those): ${r.allOff}`);
  console.log(`${apply ? 'Stamped' : 'Would stamp'}: ${apply ? r.applied : r.fromAuditLog + r.allOff}`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backfillEmailOptOut, unsubscribersFromAuditLog, allOffAccounts, ALL_OFF };
