/**
 * flag-non-wine-rows.js
 *
 * Registry audit 2026-07-26 (B8): 44 rows in the wine registry are not wine —
 * one 2026-07-07 session imported an entire spirits bar (Jack Daniel's,
 * Johnnie Walker, tequilas, grappas…), plus an April cider/alcohol-free
 * cluster and three sakes. All are owned by users, so nothing may be deleted.
 * Policy (Johan, 2026-07-26): KEEP the rows and their bottles, HIDE them from
 * registry search, type facets, public taxonomy/OG/sitemap listings and the
 * admin duplicate-scan pools — i.e. set WineDefinition.nonWine.
 *
 * The id list below is the audit's confirmed non_wine finding set, verbatim.
 * Each row is looked up and printed before flagging; ids that no longer exist
 * are reported and skipped. Already-flagged rows are counted as no-ops, so
 * the script is idempotent and safe to re-run.
 *
 * On --apply, each flagged row is also removed from the Meilisearch index
 * (their documents predate the exclusion). No backup file is written — the
 * flag is a boolean the admin non-wine endpoint can reverse per row, and the
 * full id list IS this file.
 *
 * Dry-run by default.
 *
 * Usage:
 *   node src/scripts/flag-non-wine-rows.js            # dry run
 *   node src/scripts/flag-non-wine-rows.js --apply    # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

// Registry audit 2026-07-26, category non_wine — 44 confirmed rows.
const NON_WINE_IDS = [
  '69f07610cfe7ecdc31f06cb0', '6a0ffb98a1cf43519eccaf47', '69f07e8bcfe7ecdc31f07c7f',
  '6a4d631c00378da992426589', '6a4d648f00378da9924270ad', '69db5dabbcd6b4d68a78d41d',
  '6a4d69bc00378da992427aaa', '6a4d635d00378da992426636', '6a4d5d0500378da992425fd6',
  '6a14a270039226deb9b0a7ad', '6a4d633e00378da9924265e2', '6a4d630300378da992426531',
  '6a4d639b00378da99242673c', '6a4d667e00378da99242755b', '69d290b53dcca3f60841d57d',
  '6a4d644c00378da992426f84', '69db65fbbcd6b4d68a78e015', '69db5edabcd6b4d68a78d687',
  '69db6670bcd6b4d68a78e167', '6a4d5c5d00378da992425ecc', '6a4d5bc800378da992425dcf',
  '6a4d637200378da99242668a', '6a4d5c7d00378da992425f25', '6a4d646000378da992426fd9',
  '6a4d638800378da9924266e0', '69db5ec7bcd6b4d68a78d63d', '6a1dacfe341b290385b0cebc',
  '6a4d643200378da992426f33', '6a4d63e900378da992426b37', '69f07cfbcfe7ecdc31f07858',
  '6a4d5dd500378da9924260fc', '6a4d63c000378da992426ac4', '6a4d64ee00378da9924271f0',
  '6a4d63ff00378da992426b93', '6a4d641700378da992426edb', '6a4d63ac00378da992426789',
  '69f075d9cfe7ecdc31f06be4', '6a4d5df700378da992426159', '6a4d64a100378da992427110',
  '69db5eb1bcd6b4d68a78d5e8', '69db65a2bcd6b4d68a78df2a', '6a4d5c4200378da992425e74',
  '6a4d5e6d00378da99242624f', '69f075f1cfe7ecdc31f06c35',
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const stats = { flagged: 0, already: 0, missing: 0 };
  for (const id of NON_WINE_IDS) {
    const w = await WineDefinition.findById(id).select('name producer nonWine').lean();
    if (!w) { stats.missing += 1; console.log(`  MISSING ${id}`); continue; }
    if (w.nonWine === true) { stats.already += 1; continue; }
    console.log(`  ${tag} "${w.name}" — ${w.producer} [${id}]`);
    if (APPLY) {
      await WineDefinition.updateOne({ _id: id }, { $set: { nonWine: true, updatedAt: new Date() } });
      searchService.removeWine(id);
    }
    stats.flagged += 1;
  }

  console.log(`\nFlagged: ${stats.flagged}  already flagged: ${stats.already}  missing: ${stats.missing}  of ${NON_WINE_IDS.length}`);
  if (APPLY) {
    console.log('Rows removed from Meilisearch; owners keep their bottles and wine pages.');
    console.log('No re-embed needed: nonWine is not in the embedding text (embeddings for');
    console.log('these rows are harmless leftovers; semantic search dedupes against Mongo).');
  }
  await mongoose.disconnect();
}

run().catch((err) => { console.error('flag-non-wine-rows failed:', err); process.exit(1); });
