/**
 * backfill-nv-relative-flag.js
 *
 * One-off companion to the fix that derives WineVintageProfile.relative from
 * the vintage at seed time (support ticket d49d2b36). Before that fix every
 * NV profile was created with relative:false, so the backlog splits two ways:
 *
 *   SAFE     — NV profiles with relative:false and NO phase values (pending
 *              stubs, or reviewed rows carrying only a curator note). Flipping
 *              the flag changes nothing an owner sees; it only makes the row
 *              consistent and pre-answers the curator's next write.
 *              → this script sets relative:true on them (with --apply).
 *
 *   UNSAFE   — NV profiles with relative:false and phase VALUES. Those values
 *              were written as absolute calendar years against a wine with no
 *              vintage — the window renders normally and means nothing.
 *              Flipping the flag alone would be worse ("peak 2026 years after
 *              purchase"), so these are NEVER modified here. They are printed
 *              as a re-curation list: rewrite each via set_vintage_maturity
 *              (wine_id + vintage "NV") with proper 0–100 offsets, which sets
 *              the flag as a side effect.
 *
 * Behaviour:
 *   - DRY-RUN by default: prints both cohorts, changes nothing.
 *   - Pass --apply to flip the SAFE cohort's flag.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-nv-relative-flag.js          # dry run
 *   docker exec cellarion-backend node src/scripts/backfill-nv-relative-flag.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineDefinition = require('../models/WineDefinition');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

const PHASE_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];
const hasPhaseValues = (p) => PHASE_FIELDS.some((f) => p[f] !== null && p[f] !== undefined);

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (safe rows will be flagged relative:true)' : 'Mode: DRY RUN (no changes)');
  console.log('');

  const rows = await WineVintageProfile.find({ vintage: 'NV', relative: { $ne: true } }).lean();
  console.log(`NV profiles with relative:false        ${rows.length}`);

  const safe = rows.filter((p) => !hasPhaseValues(p));
  const unsafe = rows.filter(hasPhaseValues);
  console.log(`  no phase values (safe to flag):      ${safe.length}`);
  console.log(`  phase values present (re-curation):  ${unsafe.length}`);

  if (unsafe.length > 0) {
    const wines = await WineDefinition.find(
      { _id: { $in: unsafe.map((p) => p.wineDefinition) } },
      'name producer'
    ).lean();
    const byId = new Map(wines.map((w) => [String(w._id), w]));
    console.log('\nRE-CURATION LIST — rewrite each via set_vintage_maturity');
    console.log('(wine_id + vintage "NV", offsets 0–100; the write sets the flag itself):\n');
    for (const p of unsafe) {
      const w = byId.get(String(p.wineDefinition)) || {};
      // Values ≤100 across the board look like offsets stored before the flag
      // logic existed — probably safe to re-enter verbatim; years need real
      // re-curation. Labelled so the somm can triage at a glance.
      const values = PHASE_FIELDS.filter((f) => p[f] !== null && p[f] !== undefined).map((f) => `${f}=${p[f]}`);
      const looksLikeOffsets = PHASE_FIELDS.every((f) => p[f] === null || p[f] === undefined || p[f] <= 100);
      console.log(`  wine_id ${p.wineDefinition}  [${p.status}${looksLikeOffsets ? ', offset-like values' : ', absolute years'}]`);
      console.log(`    ${w.producer || '?'} — ${w.name || '?'}`);
      console.log(`    ${values.join('  ')}${p.sommNotes ? '  (has somm note)' : ''}`);
    }
  }

  if (safe.length > 0) {
    if (APPLY) {
      const res = await WineVintageProfile.updateMany(
        { _id: { $in: safe.map((p) => p._id) }, relative: { $ne: true } },
        { $set: { relative: true } }
      );
      console.log(`\n  → flagged ${res.modifiedCount} value-less NV profiles relative:true`);
    } else {
      console.log(`\n  (dry run — would flag ${safe.length} value-less NV profiles relative:true)`);
    }
  } else {
    console.log('\nNo safe rows to flag.');
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
