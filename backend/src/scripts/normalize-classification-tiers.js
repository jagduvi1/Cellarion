/**
 * normalize-classification-tiers.js
 *
 * The appellation's regulatory mark (DOCG, DOC, AOC, IGT, AVA — as an
 * acronym, dotted, or spelled out) is not a classification: it follows from
 * the appellation. The scan and import prompts nevertheless asked for "the
 * official classification" and the model answered with the mark, which was
 * stored as the tier (GitHub discussion #1696 — about 310 registry rows). The
 * write paths now drop it (utils/normalize.normalizeClassification, applied
 * by the WineDefinition pre-validate hook); this cleans up the existing rows.
 *
 * Classification is not part of any key, so there is nothing to collide
 * with: each affected row gets the normalised tier (or null) and a fresh
 * updatedAt. The search index does not carry the field, and the AI profile
 * is left as it is (it regenerates on the next real record edit).
 *
 * Dry-run by default. On --apply: appends each row's old value to an NDJSON
 * backup before writing it (scripts/lib/backupLog: --backup-dir=<dir> or
 * SCRIPT_BACKUP_DIR, default the OS temp dir).
 *
 * Usage:
 *   node src/scripts/normalize-classification-tiers.js            # dry run
 *   node src/scripts/normalize-classification-tiers.js --apply    # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeClassification } = require('../utils/normalize');
const { createBackupLog } = require('./lib/backupLog');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

// A canary keeps the fields it was seeded with; everything else with a
// classification is a candidate (drafts and pending rows included — the
// field is private display data there, and it leaves with the same rule).
const CANDIDATES = {
  classification: { $nin: [null, ''] },
  canary: { $ne: true },
};

/**
 * The write for one row, or null when its classification is already what
 * the rule would store. Pure, so the test pins the decision without a DB.
 */
function planClassificationFix(row) {
  const next = normalizeClassification(row.classification);
  if (next === row.classification) return null;
  return { $set: { classification: next, updatedAt: new Date() } };
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const wines = await WineDefinition
    .find(CANDIDATES)
    .select('name producer classification')
    .lean();

  const stats = { scanned: 0, cleared: 0, trimmed: 0, same: 0 };
  const backup = createBackupLog('classification-tiers');
  let shown = 0;

  for (const w of wines) {
    stats.scanned += 1;
    const update = planClassificationFix(w);
    if (!update) { stats.same += 1; continue; }

    const next = update.$set.classification;
    if (next === null) stats.cleared += 1; else stats.trimmed += 1;
    if (shown < 60) {
      console.log(`${tag} "${w.name}" — ${w.producer}:  "${w.classification}"  →  ${next === null ? '(none)' : `"${next}"`}`);
      shown += 1;
    }

    if (APPLY) {
      backup.append({ _id: String(w._id), classification: w.classification });
      await WineDefinition.updateOne({ _id: w._id }, update);
    }
  }

  if (APPLY) backup.report();

  console.log(`\nSummary: ${stats.scanned} wines with a classification, ${stats.cleared} ${APPLY ? 'cleared' : 'would be cleared'} (only the mark), ${stats.trimmed} ${APPLY ? 'trimmed' : 'would be trimmed'} (mark next to a real tier), ${stats.same} already clean.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Classification cleanup failed:', err); process.exit(1); });
}

module.exports = { CANDIDATES, planClassificationFix };
