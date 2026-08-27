#!/usr/bin/env node
/**
 * Apply the appellation-geography downgrade to rows already in the registry.
 *
 * The rule itself lives in the enrichment write path (fourth branch of the
 * suspect downgrade chain, DOWNGRADE_RULES.APPELLATION_GEOGRAPHY) and runs on
 * every new generation from v1.177. This is the one-off backfill for rows
 * flagged before it existed — the same shape as apply-epistemic-downgrade.js.
 *
 * WHY (somm 6a8eb2a9). Five of five hand-checked producer-suspect rows were
 * false positives, and the somm asked for this narrowing to ship FIRST: a
 * record whose appellation resolves to a curated entry WITH geography — a
 * Châteauneuf, a Coonawarra — has a knowable house behind whatever the
 * producer string is, so the suspect claim cannot carry an owner-visible
 * caveat there. producerUnknown is the honest state (real house, not placed).
 *
 * The predicate is deliberately about the curated ENTRY's geography, not the
 * field being populated — the somm's own counter-examples: "Vin de France"
 * (curated, nationwide, region null) and "Qualitätswein" (a tier, not
 * curated) both stay flagged.
 *
 * NEVER touched, in addition to the sibling script's guards:
 *   - rows a human has judged (suspectDecision set) or authored (source
 *     'curator');
 *   - rows blocked by the placeholder / place-conflict blockers — a
 *     placeholder producer has nothing to verify however real the
 *     appellation, and a note describing a different place puts the
 *     appellation itself in doubt;
 *   - rows whose wine carries an OPEN or ANSWERED owner inquiry — the somm
 *     deliberately left Padulone undecided because clearing the flag would
 *     decide over a live escalation on the same evidence (6a8eb2a9
 *     follow-up, 2026-08-27). The inquiry resolves first.
 *
 * DRY BY DEFAULT. Pass --apply to write.
 *
 *   node src/scripts/apply-appellation-geography-downgrade.js            # report only
 *   node src/scripts/apply-appellation-geography-downgrade.js --apply
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
require('../models/Region');
require('../models/Country');
const {
  notePlaceConflict, producerFieldLooksPlaceholder, DOWNGRADE_RULES,
} = require('../utils/producerSuspectCheck');
const { appellationHasGeography } = require('../services/appellationResolve');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const rows = await WineDefinition.find({
    'aiProfile.producerSuspect': true,
    // A curator verdict outranks any rule.
    'aiProfile.suspectDecision': { $in: [null, undefined] },
    'aiProfile.source': { $ne: 'curator' },
    nonWine: { $ne: true },
  })
    .select('name producer appellation aiProfile.producerNote aiProfile.heldAt aiProfile.source')
    .populate('region', 'name')
    .populate('country', 'name')
    .lean();

  const inquiryWineIds = new Set(
    (await WineOwnerInquiry.find({
      wineDefinition: { $in: rows.map((r) => r._id) },
      status: { $in: ['open', 'answered'] },
    }).select('wineDefinition').lean()).map((i) => String(i.wineDefinition))
  );

  const move = [];
  let blockedCount = 0;
  let inquiryCount = 0;
  let noGeoCount = 0;
  for (const w of rows) {
    if (inquiryWineIds.has(String(w._id))) { inquiryCount++; continue; }
    const note = w.aiProfile.producerNote || '';
    if (
      producerFieldLooksPlaceholder(w.producer, w.name) ||
      notePlaceConflict(note, { region: w.region?.name, appellation: w.appellation, country: w.country?.name })
    ) { blockedCount++; continue; }
    if (!(await appellationHasGeography(w.appellation))) { noGeoCount++; continue; }
    move.push({ w });
  }
  console.log(`suspect rows considered : ${rows.length}`);
  console.log(`skipped — live owner inquiry            : ${inquiryCount}`);
  console.log(`blocked — placeholder / place conflict  : ${blockedCount}`);
  console.log(`kept — no curated geography             : ${noGeoCount}`);
  const held = move.filter((m) => m.w.aiProfile.heldAt).length;
  console.log(`would downgrade         : ${move.length}  (${held} of them currently HELD)`);
  for (const { w } of move.slice(0, 30)) {
    console.log(`   [${DOWNGRADE_RULES.APPELLATION_GEOGRAPHY}] "${w.producer}" / "${w.name}"  ap="${w.appellation}"`);
  }
  if (move.length > 30) console.log(`   … and ${move.length - 30} more`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  let n = 0;
  for (const { w } of move) {
    await WineDefinition.updateOne(
      { _id: w._id },
      {
        $set: {
          'aiProfile.producerSuspect': false,
          'aiProfile.producerUnknown': true,
          'aiProfile.suspectDowngradedBy': DOWNGRADE_RULES.APPELLATION_GEOGRAPHY,
        },
      }
    );
    n++;
  }
  console.log(`\nUPDATED ${n} wine(s).`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
