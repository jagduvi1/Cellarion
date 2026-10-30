/**
 * backfill-cred-accepted-suggestions.js
 *
 * Cellar Cred for the suggestions accepted before they earned any: wine
 * corrections an admin approved (every kind) and registry values a curator
 * published. The daily suggestion budget answers "the limit rises as your
 * accepted contributions grow"; until the live paths awarded them, these rows
 * counted for nothing.
 *
 * Every award goes through services/suggestionCred, the helper the live
 * approve and publish paths use: the same exclusions (a suggestion decided by
 * its own suggester, staff accounts, accounts that are gone, a non-wine flag
 * whose wine was restored) and the same per-row marker (credAwardedAt). A row
 * earns once — a second run awards nothing, and a row the live path awarded
 * meanwhile is passed over. No notifications, no emails; --apply writes one
 * audit row per member whose score it raised.
 *
 * Reads BATCH rows at a time in _id order and awards row by row (each award
 * an atomic, clamped update), so it is safe to run on production while the
 * app is up.
 *
 * DRY-RUN BY DEFAULT — prints, per member who would earn: accepted
 * corrections, published values, points, score before → after and tier
 * before → after; then the totals, and why the other rows earn nothing.
 * Pass --apply to award.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-cred-accepted-suggestions.js
 *   docker exec cellarion-backend node src/scripts/backfill-cred-accepted-suggestions.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { unawardedBatch, planAwards, awardRows, EVENTS } = require('../services/suggestionCred');
const { POINT_VALUES, getTier } = require('../utils/cellarCred');
const { logAudit } = require('../services/audit');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const BATCH = 200;
const COUNTER = { proposal: 'corrections', value: 'values' };

/**
 * One pass over the accepted corrections, then the published values.
 * A dry run (apply false) writes nothing.
 * @returns {Promise<{members: object[], totals: object, skipped: object}>}
 */
async function backfill({ apply = false, batchSize = BATCH } = {}) {
  const byUser = new Map();
  const skipped = { self: 0, staff: 0, gone: 0, restored: 0 };

  for (const kind of ['proposal', 'value']) {
    let after = null;
    for (;;) {
      const rows = await unawardedBatch(kind, { after, limit: batchSize });
      if (!rows.length) break;
      after = rows[rows.length - 1]._id;

      const plan = await planAwards(kind, rows);
      for (const reason of Object.keys(skipped)) skipped[reason] += plan.skipped[reason];
      // The score as read before this run awarded the member anything.
      for (const { userId } of plan.earning) {
        if (byUser.has(userId)) continue;
        const user = plan.users.get(userId);
        byUser.set(userId, {
          userId,
          username: user.username || userId,
          scoreBefore: user.contribution?.totalScore || 0,
          tierBefore: user.contribution?.tier || 'newcomer',
          corrections: 0,
          values: 0,
        });
      }

      const counted = apply ? await awardRows(kind, plan.earning) : plan.earning;
      for (const { userId } of counted) byUser.get(userId)[COUNTER[kind]]++;
      if (rows.length < batchSize) break;
    }
  }

  const members = [...byUser.values()]
    .map((m) => {
      const points = m.corrections * POINT_VALUES[EVENTS.proposal] + m.values * POINT_VALUES[EVENTS.value];
      return { ...m, points, scoreAfter: m.scoreBefore + points, tierAfter: getTier(m.scoreBefore + points) };
    })
    .filter((m) => m.points > 0)
    .sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));

  // One trace per member whose score this run changed.
  if (apply) {
    for (const m of members) {
      logAudit(null, 'cred.accepted_suggestions.backfill', { type: 'user', id: m.userId },
        { corrections: m.corrections, values: m.values, points: m.points, scoreBefore: m.scoreBefore, tierBefore: m.tierBefore, tierAfter: m.tierAfter });
    }
  }

  const sum = (field) => members.reduce((n, m) => n + m[field], 0);
  const totals = {
    members: members.length,
    corrections: sum('corrections'),
    values: sum('values'),
    points: sum('points'),
    tierChanges: members.filter((m) => m.tierAfter !== m.tierBefore).length,
  };
  return { members, totals, skipped };
}

function printReport({ members, totals, skipped }, { apply = false, log = console.log } = {}) {
  if (!members.length) {
    log('Nothing to award: every accepted suggestion that earns has been awarded.');
  } else {
    const width = Math.max(6, ...members.map((m) => m.username.length));
    log(`${'Member'.padEnd(width)}  Corrections  Values  Points  Score            Tier`);
    for (const m of members) {
      const score = `${m.scoreBefore} → ${m.scoreAfter}`;
      const tier = m.tierAfter === m.tierBefore ? m.tierBefore : `${m.tierBefore} → ${m.tierAfter}`;
      log(`${m.username.padEnd(width)}  ${String(m.corrections).padStart(11)}  ${String(m.values).padStart(6)}  ${`+${m.points}`.padStart(6)}  ${score.padEnd(15)}  ${tier}`);
    }
  }
  log('');
  log(`${apply ? 'Awarded' : 'Would award'}: ${totals.members} member(s); ${totals.corrections} accepted correction(s) `
    + `(+${totals.corrections * POINT_VALUES[EVENTS.proposal]}), ${totals.values} published value(s) `
    + `(+${totals.values * POINT_VALUES[EVENTS.value]}) = +${totals.points} points; ${totals.tierChanges} tier change(s)`);
  log(`Not earning: ${skipped.staff} by staff accounts, ${skipped.self} decided by their own suggester, `
    + `${skipped.gone} from accounts that are gone, ${skipped.restored} non-wine flag(s) whose wine was restored`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log(`Mode: ${apply ? 'APPLY (awards are written)' : 'DRY-RUN (no changes; pass --apply to award)'}\n`);
  printReport(await backfill({ apply }), { apply });
  console.log(apply ? '\nDone.' : '\nDry-run complete — nothing written. Re-run with --apply to award.');
  // logAudit persists fire-and-forget: let the last rows land before the
  // connection closes, or they are dropped silently.
  if (apply) await new Promise((resolve) => setTimeout(resolve, 1000));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { backfill, printReport };
