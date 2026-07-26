/**
 * scan-name-anomalies — size the registry name-check queues (support ticket
 * 2026-07-26). Read-only; changes nothing, has no --apply flag.
 *
 * Prints, per rule in utils/nameChecks.js: outstanding / already-cleared /
 * total-matching, plus up to 40 sample rows. Use it BEFORE trusting a newly
 * added or refined rule, and to re-tune DANGLING_TAIL_WORDS from evidence
 * rather than guesswork (widening the set means bumping the rule id).
 *
 * Usage:
 *   docker exec cellarion-backend node src/scripts/scan-name-anomalies.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { NAME_CHECKS, NAME_CHECK_SELECT } = require('../utils/nameChecks');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log('Connected. Mode: READ-ONLY (this script never writes)\n');

  const all = await WineDefinition.find({}).select(`${NAME_CHECK_SELECT} verifiedAt`).lean();
  for (const check of NAME_CHECKS) {
    const matching = all.filter(w => check.detect(w));
    const cleared = matching.filter(w => (w.verifiedChecks || []).includes(check.id));
    const outstanding = matching.filter(w => !(w.verifiedChecks || []).includes(check.id));
    console.log(`${check.id}${check.defaultActive ? '' : '  (not in the default queue)'}`);
    console.log(`  matching=${matching.length}  cleared=${cleared.length}  outstanding=${outstanding.length}`);
    for (const w of outstanding.slice(0, 40)) {
      console.log(`    "${w.name}" — ${w.producer} [${w._id}]`);
    }
    if (outstanding.length > 40) console.log(`    … and ${outstanding.length - 40} more`);
    console.log('');
  }
  console.log(`Scanned ${all.length} registry wines.`);
  console.log('No Meilisearch re-index and NO embedding job are needed — verification is in');
  console.log('neither the search document nor the embedding text. Do not run the embed job.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Name-anomaly scan failed:', err); process.exit(1); });
