/**
 * clear-method-appellations.js
 *
 * A production method is not an appellation (GitHub discussion #1696):
 * "Méthode Traditionnelle", "Metodo Classico", "Méthode Cap Classique" say how
 * a sparkling wine was made, not where it is from. Our own scan, import and
 * text-search prompts nevertheless told the model to put them in the
 * appellation field. The write paths now store a value that is nothing but a
 * method as no appellation (utils/normalize.isProductionMethodOnly, applied by
 * the WineDefinition pre-validate hook and by every key builder); this clears
 * the existing rows.
 *
 * Only a value that is NOTHING BUT a method is cleared. A value with a place
 * in it ("Touraine AOP – Méthode Traditionnelle", "Asti DOCG Metodo Classico")
 * is listed for a curator and left alone: the same words end real appellation
 * names ("Oltrepò Pavese Metodo Classico").
 *
 * The appellation is the last segment of both keys. Each key gets that segment
 * emptied and keeps everything else byte for byte — the producer or the
 * `pending~<creator>` / `draft~<creator>` namespace, the name, the label
 * sweetness suffix — so nothing but the method leaves it. A key that does not
 * end in the method (written by an older rule) is left as it is. normalizedKey
 * is UNIQUE: a row whose new key another wine already holds is a real
 * duplicate, SKIPPED and reported for a merge. This script never merges.
 *
 * The AI profile reads the appellation: a row whose profile was in sync gets
 * its snapshot moved along, so the cleanup queues no paid regeneration (the
 * same rule as normalize-classification-tiers.js). On --apply each row is
 * re-indexed in Meili; run the admin embedding job afterwards (the
 * appellation feeds the embed text).
 *
 * Dry-run by default. On --apply: appends each row's old values to an NDJSON
 * backup before writing it (scripts/lib/backupLog: --backup-dir=<dir> or
 * SCRIPT_BACKUP_DIR, default the OS temp dir).
 *
 * Usage:
 *   node src/scripts/clear-method-appellations.js            # dry run
 *   node src/scripts/clear-method-appellations.js --apply    # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { isProductionMethodOnly, normalizeString, normalizeAppellation, stripSweetnessKeySegment } = require('../utils/normalize');
const { profileInputsSnapshot } = require('../services/enrichmentJob');
const searchService = require('../services/search');
const { initSearch } = require('./lib/scriptSearch');
const { createBackupLog } = require('./lib/backupLog');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

// Every row whose appellation mentions a method; planMethodFix decides which
// of them hold nothing else. Drafts and pending rows are included — the rule
// is the same there. A canary keeps the fields it was seeded with.
const METHOD_WORDS = /(m[ée]thode|m[ée]todo|traditional method|cap classique|flascheng[äa]rung|\bmcc\b)/i;
const CANDIDATES = {
  appellation: { $regex: METHOD_WORDS },
  canary: { $ne: true },
};

// What profileInputsSnapshot reads, the two keys, and the stored snapshot.
const FIELDS = 'name producer country region appellation classification type grapes normalizedKey canonicalKey aiProfile.inputsSnapshot';

/**
 * The key with its appellation segment emptied, every other byte kept (the
 * label sweetness suffix included); null when the key does not end in
 * `segment`, so a key some older rule wrote is left alone.
 */
function withoutAppellationSegment(key, segment) {
  if (typeof key !== 'string' || !key || !segment) return null;
  const bare = stripSweetnessKeySegment(key);
  const cut = bare.lastIndexOf(':');
  if (cut < 0 || bare.slice(cut + 1) !== segment) return null;
  return `${bare.slice(0, cut + 1)}${key.slice(bare.length)}`;
}

/**
 * The write for one row, or null when its appellation is not a production
 * method on its own (nothing to clear, or a place a curator must judge).
 * Pure, so the test pins the decision without a DB.
 */
function planMethodFix(row) {
  if (!isProductionMethodOnly(row.appellation)) return null;
  const $set = { appellation: null, updatedAt: new Date() };
  const normalizedKey = withoutAppellationSegment(row.normalizedKey, normalizeString(row.appellation));
  if (normalizedKey) $set.normalizedKey = normalizedKey;
  const canonicalKey = withoutAppellationSegment(row.canonicalKey, normalizeString(normalizeAppellation(row.appellation) || ''));
  if (canonicalKey) $set.canonicalKey = canonicalKey;
  const stored = row.aiProfile && row.aiProfile.inputsSnapshot;
  if (stored && stored === profileInputsSnapshot(row)) {
    $set['aiProfile.inputsSnapshot'] = profileInputsSnapshot({ ...row, appellation: null });
  }
  return { $set };
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);
  const searchOk = APPLY ? await initSearch({ label: 'clear-method-appellations' }) : false;

  const wines = await WineDefinition.find(CANDIDATES).select(FIELDS).lean();

  const stats = { scanned: 0, cleared: 0, byHand: 0, collisions: 0, snapshotMoved: 0 };
  const backup = createBackupLog('method-appellations');

  for (const w of wines) {
    stats.scanned += 1;
    const update = planMethodFix(w);
    if (!update) {
      stats.byHand += 1;
      console.log(`  ✋ by hand (a place beside the method): "${w.appellation}" — ${w.producer} "${w.name}" (${w._id})`);
      continue;
    }

    const newKey = update.$set.normalizedKey;
    if (newKey) {
      const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id').lean();
      if (clash) {
        stats.collisions += 1;
        console.log(`  ⚠ collision (manual merge): "${w.name}" — ${w.producer} | "${w.appellation}" → (none) clashes with ${clash._id}`);
        continue;
      }
    }

    stats.cleared += 1;
    if (update.$set['aiProfile.inputsSnapshot']) stats.snapshotMoved += 1;
    console.log(`${tag} "${w.name}" — ${w.producer}:  "${w.appellation}"  →  (none)${newKey ? '' : '  [key left as written]'}`);

    if (APPLY) {
      backup.append({
        _id: String(w._id), appellation: w.appellation, normalizedKey: w.normalizedKey || null,
        canonicalKey: w.canonicalKey || null, inputsSnapshot: (w.aiProfile && w.aiProfile.inputsSnapshot) || null,
      });
      await WineDefinition.updateOne({ _id: w._id }, update);
      if (searchOk) await searchService.indexWine(w._id);
    }
  }

  if (APPLY) backup.report();

  console.log(`\nSummary: ${stats.scanned} wines whose appellation mentions a method, ${stats.cleared} ${APPLY ? 'cleared' : 'would be cleared'} (only the method), ${stats.byHand} left for a curator (a place beside it), ${stats.collisions} collisions left for manual merge; ${stats.snapshotMoved} profile snapshot(s) moved along so no regeneration is queued.`);
  if (APPLY && stats.cleared) console.log('Next: run the admin embedding job (the appellation feeds the embed text).');
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Method appellation cleanup failed:', err); process.exit(1); });
}

module.exports = { CANDIDATES, planMethodFix, withoutAppellationSegment };
