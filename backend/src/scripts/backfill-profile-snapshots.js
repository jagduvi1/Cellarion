#!/usr/bin/env node
/**
 * Stamp aiProfile.inputsSnapshot on enriched rows that carry none.
 *
 * WHY. Every generation records the identity it was generated from, so a
 * later bulk write that bypasses reenrichAfterRecordEdit is detectable as
 * staleness (a row whose identity was rewritten otherwise keeps a profile
 * describing its old identity). A profile without a snapshot has no such
 * guard until it is re-enriched.
 *
 * ⚠️ WHAT THIS CANNOT DO. The snapshot is the identity the profile was
 * generated from, and for these rows that value was never recorded — so
 * this stamps the CURRENT identity, which asserts "this profile matches this
 * record". For a row that is already stale that assertion is wrong, and
 * stamping it hides the staleness permanently.
 *
 * Therefore: run this AFTER re-enriching the rows already known to be stale.
 * It is a baseline, not a repair: the staleness of a row without a snapshot
 * is not recoverable from stored data, because nothing stored what the
 * profile was generated from. By default it leaves the producer-suspect
 * population alone (--include-suspect takes it in), since that is where
 * known-stale rows concentrate and where a wrong baseline costs the most.
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
