/**
 * Backtest of the new-member emails (services/newMemberEmails): which accounts
 * WOULD have got one, had the job run at 17:00 UTC on each of the past days.
 * READ-ONLY, and it prints counts only: no ids, names or addresses.
 *
 * It calls the job's own selection (findCandidates) in backtest mode: the
 * admin switch, sent stamps and device sessions are ignored (a session keeps
 * only its latest use), and bottles are counted as they were by then. Each
 * account is counted once, on the first day it would have been emailed.
 *
 * For each day it also shows what later happened to the people picked: how
 * many came back within 7 days anyway, without any email. That is the
 * baseline the real emails are measured against.
 *
 * Usage (inside the backend container):
 *   node src/scripts/new-member-emails-backtest.js            # last 28 days
 *   node src/scripts/new-member-emails-backtest.js --days 14
 */
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const { findCandidates } = require('../services/newMemberEmails');

const DAY = 24 * 60 * 60 * 1000;
const MACHINE_ACTIONS = ['token.used', 'oauth.token_refreshed', 'bridge.key.used'];
const SIGN_IN_ACTIONS = ['auth.login.success', 'auth.oauth.success'];

/** Did the account do anything in [from, to)? Same rule as "came back". */
const activeBetween = (userId, from, to) => AuditLog.exists({
  timestamp: { $gte: from, $lt: to },
  $or: [
    { 'actor.userId': userId, action: { $nin: MACHINE_ACTIONS } },
    { 'resource.id': userId, action: { $in: SIGN_IN_ACTIONS } },
  ],
});

async function backtest({ days, now = new Date() }) {
  const today17 = new Date(now);
  today17.setUTCHours(17, 0, 0, 0);
  const lastRun = today17 <= now ? today17 : new Date(today17.getTime() - DAY);

  const seen = new Set();
  const rows = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const runAt = new Date(lastRun.getTime() - i * DAY);
    const candidates = await findCandidates({ runAt, live: false });
    const row = { day: runAt.toISOString().slice(0, 10), considered: 0, cellar: 0, empty: 0, skipped: {}, backWithin7: { cellar: 0, empty: 0 }, outcomeKnown: runAt.getTime() + 7 * DAY <= now.getTime() };
    for (const { user, choice } of candidates) {
      const id = String(user._id);
      // An account sits in the window on two runs; the first decides (live, a
      // send stamps it, and "came back" only becomes more true).
      if (seen.has(id)) continue;
      seen.add(id);
      row.considered += 1;
      if (choice === 'cellar' || choice === 'empty') {
        row[choice] += 1;
        if (await activeBetween(user._id, runAt, new Date(runAt.getTime() + 7 * DAY))) row.backWithin7[choice] += 1;
      } else {
        const reason = choice.slice('skip:'.length);
        row.skipped[reason] = (row.skipped[reason] || 0) + 1;
      }
    }
    rows.push(row);
  }
  return rows;
}

function print(rows) {
  const total = { considered: 0, cellar: 0, empty: 0, skipped: {}, back: { cellar: 0, empty: 0 }, known: { cellar: 0, empty: 0 } };
  console.log('day         considered  cellar  empty  came-back-anyway(7d)  skipped');
  for (const r of rows) {
    total.considered += r.considered;
    total.cellar += r.cellar;
    total.empty += r.empty;
    for (const [k, n] of Object.entries(r.skipped)) total.skipped[k] = (total.skipped[k] || 0) + n;
    if (r.outcomeKnown) {
      for (const k of ['cellar', 'empty']) { total.back[k] += r.backWithin7[k]; total.known[k] += r[k]; }
    }
    const back = r.outcomeKnown ? `${r.backWithin7.cellar}/${r.cellar} · ${r.backWithin7.empty}/${r.empty}` : 'not yet known';
    console.log(`${r.day}  ${String(r.considered).padStart(10)}  ${String(r.cellar).padStart(6)}  ${String(r.empty).padStart(5)}  ${back.padStart(20)}  ${JSON.stringify(r.skipped)}`);
  }
  console.log('');
  console.log(`Total: ${total.considered} new accounts considered → ${total.cellar} "your cellar so far" + ${total.empty} "still empty" emails`);
  console.log(`Skipped: ${JSON.stringify(total.skipped)}`);
  console.log(`Came back within 7 days anyway (days with a known outcome): cellar ${total.back.cellar}/${total.known.cellar}, empty ${total.back.empty}/${total.known.empty}`);
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = i > -1 ? Math.max(1, Math.min(80, parseInt(process.argv[i + 1], 10) || 28)) : 28;
  // Read-only all the way: connecting must not build indexes or create
  // collections either (the running backend owns those).
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  print(await backtest({ days }));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backtest };
