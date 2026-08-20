#!/usr/bin/env node
/**
 * Stamp aiProfile.inputsSnapshot on rows enriched before the field existed.
 *
 * WHY. From v1.145 every generation records the identity it was generated
 * from, so a later bulk write that bypasses reenrichAfterRecordEdit is
 * detectable as staleness (somm 6a86bb3b — the 08-11 triage left two Friuli
 * benchmarks carrying a note about "Giuli Ballarin", the wine those rows used
 * to be). Without a backfill that protection only covers rows re-enriched from
 * now on, and the ~6,000 existing profiles stay unguarded indefinitely.
 *
 * ⚠️ WHAT THIS CANNOT DO. The snapshot is the identity the profile was
 * generated from, and for an existing row that value was never recorded — so
 * this stamps the CURRENT identity, which asserts "this profile matches this
 * record". For a row that is already stale that assertion is wrong, and
 * stamping it hides the staleness permanently.
 *
 * Therefore: run this AFTER re-enriching the rows already known to be stale.
 * It is a baseline, not a repair, and it is deliberately not retroactive —
 * pre-v1.145 staleness is not recoverable from stored data, because nothing
 * stored what the profile was generated from. --skip-suspect (default) leaves
 * the producer-suspect population alone, since that is where the known-stale
 * rows are concentrated and where a wrong baseline would cost the most.
 *
 * DRY BY DEFAULT. Pass --apply to write.
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { profileInputsSnapshot } = require('../services/enrichmentJob');

const APPLY = process.argv.includes('--apply');
const INCLUDE_SUSPECT = process.argv.includes('--include-suspect');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const filter = {
    'aiProfile.generatedAt': { $ne: null },
    $or: [{ 'aiProfile.inputsSnapshot': null }, { 'aiProfile.inputsSnapshot': { $exists: false } }],
  };
  if (!INCLUDE_SUSPECT) filter['aiProfile.producerSuspect'] = { $ne: true };

  const rows = await WineDefinition.find(filter)
    .select('name producer appellation classification type country region grapes')
    .lean();

  console.log(`rows with a profile and no snapshot: ${rows.length}`);
  console.log(`producer-suspect rows ${INCLUDE_SUSPECT ? 'INCLUDED' : 'excluded (default)'}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    if (rows[0]) console.log(`example snapshot: ${profileInputsSnapshot(rows[0]).slice(0, 160)}…`);
    await mongoose.disconnect();
    return;
  }

  let n = 0;
  const ops = [];
  for (const w of rows) {
    ops.push({
      updateOne: { filter: { _id: w._id }, update: { $set: { 'aiProfile.inputsSnapshot': profileInputsSnapshot(w) } } },
    });
    if (ops.length === 500) { await WineDefinition.bulkWrite(ops); n += ops.length; ops.length = 0; }
  }
  if (ops.length) { await WineDefinition.bulkWrite(ops); n += ops.length; }

  console.log(`\nSTAMPED ${n} row(s).`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
