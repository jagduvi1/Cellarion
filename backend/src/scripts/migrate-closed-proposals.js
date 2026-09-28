/**
 * migrate-closed-proposals.js — one-off (2026-09-28): proposals that a merge
 * or a delete closed automatically were stored as status 'rejected' with
 * decidedBy null and a reason starting "Closed automatically: …". They are
 * lifecycle closures, not a reviewer's judgement, and they read as
 * disagreements with the sommelier: 25 of the 27 "rejections" of its proposals
 * in three weeks were merges into records that already carried the proposed
 * producer. services/wineCorrectionNotify now writes them as 'closed'; this
 * moves the earlier rows.
 *
 * Idempotent: only 'rejected' rows with no decider and the automatic reason
 * are touched; a row a human rejected always has a decider.
 *
 *   node src/scripts/migrate-closed-proposals.js            # dry run: counts only
 *   node src/scripts/migrate-closed-proposals.js --apply    # move them
 */
const mongoose = require('mongoose');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');

const FILTER = { status: 'rejected', decidedBy: null, rejectReason: /^Closed automatically/ };

/** @returns {Promise<{ candidates: number, moved: number }>} */
async function migrateClosedProposals({ apply = false } = {}) {
  const candidates = await WineCorrectionProposal.countDocuments(FILTER);
  if (!apply || candidates === 0) return { candidates, moved: 0 };
  const res = await WineCorrectionProposal.updateMany(FILTER, { $set: { status: 'closed' } });
  return { candidates, moved: res.modifiedCount || 0 };
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (no changes; pass --apply to execute)'}`);
  const r = await migrateClosedProposals({ apply });
  console.log(`Merge/delete closures stored as rejected: ${r.candidates}`);
  console.log(`${apply ? 'Moved to closed' : 'Would move to closed'}: ${apply ? r.moved : r.candidates}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { migrateClosedProposals, FILTER };
