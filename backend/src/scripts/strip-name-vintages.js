/**
 * strip-name-vintages.js
 *
 * Registry audit 2026-07-26 (B2): 19 wines carry a trailing vintage year in
 * their NAME ("Reserve Cabernet Sauvignon 2023") even though the registry is
 * vintage-neutral by construction — the year belongs on Bottle.vintage. The
 * write paths now strip it on create (utils/normalize.stripTrailingVintage,
 * wired into findOrCreateWine step 0); this cleans up existing rows.
 *
 * For each wine whose name ends in a plausible vintage (1950–2049, TRAILING
 * only — leading years are brand names like "1924 Double Black"):
 *   - compute the stripped name and the new normalizedKey (name is part of
 *     the dedup key). Because normalizedKey is UNIQUE:
 *       no collision → update name + normalizedKey, re-index Meili (wine AND
 *       its bottles — bottle documents denormalize wineName);
 *       collision → SKIP and report for manual merge (the year was the only
 *       thing distinguishing two rows = a genuine duplicate).
 *   - write the stripped year to Bottle.vintage for the wine's bottles, but
 *     ONLY where the bottle is UNDATED — an owner's explicit vintage is never
 *     overwritten, even when it disagrees with the name. "Undated" means the
 *     'NV' sentinel (Bottle.vintage's default), not null; see UNDATED below.
 *
 * The wine's slug is deliberately untouched: this writes with updateOne, which
 * bypasses the model's rename hook (the hook regenerates the slug and keeps the
 * old one in previousSlugs). A trailing vintage in a slug is cosmetic and the
 * URL already works — re-slugging thousands of rows in a cleanup pass is not
 * worth the churn. Embedding: the name feeds the embed text, so touched
 * wines re-embed on the next incremental job run; start one after --apply.
 *
 * Dry-run by default. On --apply: writes a JSON backup of affected rows first.
 *
 * Usage:
 *   node src/scripts/strip-name-vintages.js            # dry run
 *   node src/scripts/strip-name-vintages.js --apply    # execute
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const searchService = require('../services/search');
const { stripTrailingVintage, generateWineKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

/**
 * What "this bottle has no vintage" actually looks like in the database.
 *
 * Bottle.vintage is a STRING with `default: 'NV'`, and parseAndValidateVintage
 * maps undefined/null/'' to 'NV' on every write path — so an undated bottle is
 * stored as 'NV' and essentially never as null. Matching only null (as this
 * script originally did) found nothing while the rename ran anyway, quietly
 * dropping the year instead of moving it onto the bottle (code audit
 * 2026-07-27, H4). Verified on prod 2026-07-28: 0 bottles at null, 535 at 'NV'.
 *
 * Matched case-INSENSITIVELY, and 'Unknown' counts too:
 *   - prod holds 26 bottles at 'Nv' next to 268 at 'NV' (sparkling alone), so
 *     some write path is not going through parseAndValidateVintage, which
 *     upper-cases. An exact-string list would repeat this script's original
 *     mistake in a smaller way.
 *   - 'Unknown' means "there IS a year, the owner can't read it" (see the
 *     validator's docstring) — precisely the bottle a year recovered from the
 *     wine name should fill in. 'NV' is more ambiguous, since it doubles as
 *     the never-touched default, but a wine whose NAME ends in a year is a
 *     vintage-dated wine that was misfiled rather than a true non-vintage
 *     blend, so filling it is right there too.
 * An owner's explicit year is still never overwritten — that is the point of
 * restricting to these values at all.
 */
const UNDATED = {
  $or: [
    { vintage: null },
    { vintage: '' },
    { vintage: { $regex: /^\s*(nv|unknown)\s*$/i } },
  ],
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const wines = await WineDefinition
    .find({ name: { $regex: /(?:19[5-9]\d|20[0-4]\d)\)?$/ } })
    .select('name producer appellation normalizedKey')
    .lean();

  const stats = { candidates: 0, changed: 0, collisions: 0, bottlesDated: 0 };
  const reindexing = [];

  // Backup is flushed after EVERY mutation, not once at the end. Buffering it
  // meant a throw mid-loop (or a Ctrl-C, or the 4GB host OOM-killing us) exited
  // through the top-level catch with the file never written — leaving the rows
  // already renamed with no pre-image on disk, exactly when a partial apply had
  // happened and the backup mattered most (code audit 2026-07-27, M3).
  let backupFile = null;
  const backupRows = [];
  const appendBackup = (row) => {
    backupRows.push(row);
    if (!backupFile) {
      backupFile = path.join(os.tmpdir(), `strip-name-vintages-backup-${Date.now()}.json`);
    }
    fs.writeFileSync(backupFile, JSON.stringify(backupRows, null, 1));
  };

  for (const w of wines) {
    const stripped = stripTrailingVintage(w.name);
    if (stripped === w.name) continue; // name IS just a year, or no real match
    stats.candidates += 1;

    // The year that was removed — what the owners' undated bottles receive.
    const yearMatch = w.name.match(/(19[5-9]\d|20[0-4]\d)/g);
    const year = yearMatch ? parseInt(yearMatch[yearMatch.length - 1], 10) : null;

    const newKey = generateWineKey(stripped, w.producer, w.appellation || '');
    const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id name').lean();
    if (clash) {
      stats.collisions += 1;
      console.log(`  SKIP (collision) "${w.name}" — ${w.producer} [${w._id}] → would collide with [${clash._id}] "${clash.name}"; merge via the admin duplicates tool instead`);
      continue;
    }

    const undated = await Bottle.countDocuments({ wineDefinition: w._id, ...UNDATED });
    console.log(`  ${tag} "${w.name}" → "${stripped}"  (year ${year} → ${undated} undated bottle(s))  [${w._id}]`);

    if (APPLY) {
      appendBackup(w);
      await WineDefinition.updateOne(
        { _id: w._id },
        { $set: {
          name: stripped,
          normalizedKey: newKey,
          // updateOne bypasses the pre-validate hook, so this scripted caller
          // owns canonicalKey — same contract backfill-canonical-key.js
          // follows. Left stale it would still encode the vintage-suffixed
          // name, and findOrCreateWine's canonical lookup would miss this row
          // and mint a twin: the exact duplicate this cleanup exists to
          // prevent (code audit 2026-07-27, M1).
          canonicalKey: computeCanonicalKey(stripped, w.producer, w.appellation),
          updatedAt: new Date(),
        } }
      );
      if (year && undated > 0) {
        const r = await Bottle.updateMany(
          { wineDefinition: w._id, ...UNDATED },
          { $set: { vintage: String(year) } }
        );
        stats.bottlesDated += r.modifiedCount || 0;
      }
      // Awaited below, before we disconnect — an un-awaited reindex reads Mongo
      // internally and can lose the connection mid-flight, leaving Meili on the
      // old name with the error swallowed (code audit 2026-07-27, M4).
      reindexing.push(searchService.indexWine(w._id));
      const bottleIds = await Bottle.distinct('_id', { wineDefinition: w._id });
      if (bottleIds.length) {
        reindexing.push(searchService.bulkIndexBottles(bottleIds));
      }
    }
    stats.changed += 1;
  }

  if (APPLY && backupFile) {
    console.log(`\nBackup of ${stats.changed} pre-change rows: ${backupFile}`);
    console.log('(container /tmp is ephemeral — docker cp it off before recreating the container)');
  }

  if (reindexing.length) {
    const results = await Promise.allSettled(reindexing);
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) console.warn(`\n⚠ ${failed}/${reindexing.length} reindex calls failed — re-run a Meili sync.`);
  }

  console.log(`\nCandidates: ${stats.candidates}  changed: ${stats.changed}  collisions(skipped): ${stats.collisions}  bottles dated: ${stats.bottlesDated}`);
  if (APPLY) console.log('Next: start the admin embedding job (incremental) — the name feeds the embed text.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('strip-name-vintages failed:', err); process.exit(1); });
