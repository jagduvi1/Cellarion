#!/usr/bin/env node
/**
 * Apply the epistemic-only downgrade to rows already in the registry.
 *
 * The rule itself lives in utils/producerSuspectCheck and runs on every new
 * generation from v1.145. This is the one-off backfill for rows enriched
 * before it existed — the same shape as reclassify-producer-suspect.js, which
 * backfilled the sibling ASSERTS_PRODUCER rule on 2026-08-19.
 *
 * WHY (somm 6a86baca). producer_suspect asserts a positive suspicion: the
 * value is a brand, a range, a retailer, a place. An epistemic note asserts no
 * such thing — it records that the model could not place the name, which is
 * what producerUnknown is for. Left as suspect, a real small estate wears a
 * permanent "cannot be verified" caveat on its wine and inflates upheld-count,
 * the number the scaling review reads as "wines the registry genuinely cannot
 * identify". Their own counter-example settled it: La Spia carried a pure
 * epistemic note and is a real Valtellina winery.
 *
 * Every moved row is tagged aiProfile.suspectDowngradedBy so the set stays
 * queryable (list_rule_downgrades) and a wrong rule can be reversed wholesale.
 *
 * A row a HUMAN has judged (suspectDecision set) is never touched: 'upheld'
 * means a curator looked at this exact question and said the flag is right.
 *
 * DRY BY DEFAULT. Pass --apply to write.
 *
 *   node src/scripts/apply-epistemic-downgrade.js            # report only
 *   node src/scripts/apply-epistemic-downgrade.js --apply
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
require('../models/Region');
require('../models/Country');
const {
  noteAssertsProducer, noteIsEpistemicOnly,
  notePlaceConflict, producerFieldLooksPlaceholder, DOWNGRADE_RULES,
} = require('../utils/producerSuspectCheck');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const rows = await WineDefinition.find({
    'aiProfile.producerSuspect': true,
    'aiProfile.producerNote': { $ne: null },
    // A curator verdict outranks any rule.
    'aiProfile.suspectDecision': { $in: [null, undefined] },
    // A curator-authored profile is a human judgement about this exact row —
    // no rule overrides it (somm audit 6a86dad6: The Parish moved despite a
    // curator verification two days earlier).
    'aiProfile.source': { $ne: 'curator' },
    nonWine: { $ne: true },
  })
    .select('name producer appellation aiProfile.producerNote aiProfile.heldAt aiProfile.source')
    .populate('region', 'name')
    .populate('country', 'name')
    .lean();

  const move = [];
  let blockedCount = 0;
  for (const w of rows) {
    const note = w.aiProfile.producerNote || '';
    // Blockers before rules — see the same composition at the enrichment
    // write site (somm audit 6a86dad6: placeholder fields and place-conflict
    // notes must stay suspect for a human).
    if (
      producerFieldLooksPlaceholder(w.producer, w.name) ||
      notePlaceConflict(note, { region: w.region?.name, appellation: w.appellation, country: w.country?.name })
    ) { blockedCount++; continue; }
    // Strongest claim first, so the two rules stay disjoint and the tag on
    // each row names the rule that actually decided it.
    if (noteAssertsProducer(note, w.producer)) {
      move.push({ w, rule: DOWNGRADE_RULES.ASSERTS_PRODUCER });
    } else if (noteIsEpistemicOnly(note, w.producer)) {
      move.push({ w, rule: DOWNGRADE_RULES.EPISTEMIC_ONLY });
    }
  }
  console.log(`blocked from downgrading (placeholder / place conflict): ${blockedCount}`);

  const held = move.filter((m) => m.w.aiProfile.heldAt).length;
  console.log(`suspect rows considered : ${rows.length}`);
  console.log(`would downgrade         : ${move.length}  (${held} of them currently HELD)`);
  for (const { w, rule } of move.slice(0, 15)) {
    console.log(`   [${rule}] "${w.producer}" / "${w.name}"`);
  }
  if (move.length > 15) console.log(`   … and ${move.length - 15} more`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  let n = 0;
  for (const { w, rule } of move) {
    // Clearing heldAt too: the hold existed because the producer field was
    // believed wrong. Once the flag says "real winery we cannot place", the
    // reason to withhold is gone — that is exactly the producerUnknown
    // contract (publish, no owner-visible caveat). Rows whose description was
    // never generated because of the hold get one on the next enrichment pass.
    await WineDefinition.updateOne(
      { _id: w._id },
      {
        $set: {
          'aiProfile.producerSuspect': false,
          'aiProfile.producerUnknown': true,
          'aiProfile.suspectDowngradedBy': rule,
        },
      }
    );
    n++;
  }
  console.log(`\nUPDATED ${n} wine(s).`);

  const left = await WineDefinition.countDocuments({
    'aiProfile.producerSuspect': true,
    'aiProfile.suspectDecision': { $in: [null, undefined] },
    nonWine: { $ne: true },
  });
  console.log(`suspect rows still awaiting a verdict: ${left}`);

  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
