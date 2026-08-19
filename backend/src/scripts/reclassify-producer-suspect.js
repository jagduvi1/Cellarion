/**
 * reclassify-producer-suspect.js — somm ticket 6a85f961.
 *
 * 94.7% of the published-suspect queue was generated BEFORE the 2026-08-17
 * flag split, when "this value is not a producer" and "this is a real winery I
 * cannot place" shared one boolean. Those rows never saw producerUnknown, so
 * real small estates — La Spia, Château Jeandeman, Cave de Sainte-Marie — sit
 * in a judgement queue wearing an owner-visible "cannot be verified" caveat.
 *
 * The model already told us which is which, in the note it wrote at the time.
 * So this reads STORED TEXT and costs NOTHING: no AI calls, no re-generation,
 * no changed descriptions. Only the two flags move, and only in the safe
 * direction — suspect → unknown, which PUBLISHES without a caveat.
 *
 * What it deliberately does not touch:
 *   - rows whose note is the category-only "not a producer I can confidently
 *     place" shape. That population is genuinely ambiguous and stays for a
 *     human or a web-search rescue.
 *   - rows whose note names a brand, retailer or range. Those are the flag
 *     working correctly.
 *   - anything already decided (suspectDecision set).
 *
 * Dry by default; --apply writes. Idempotent either way.
 *
 *   docker exec cellarion-backend node src/scripts/reclassify-producer-suspect.js
 *   docker exec cellarion-backend node src/scripts/reclassify-producer-suspect.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { noteAssertsProducer } = require('../utils/producerSuspectCheck');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  const WineDefinition = require('../models/WineDefinition');

  const rows = await WineDefinition.find({
    'aiProfile.producerSuspect': true,
    'aiProfile.description': { $ne: null },
    'aiProfile.heldAt': null,
    'aiProfile.suspectDecision': { $in: [null, undefined] },
    nonWine: { $ne: true },
  }).select('producer name aiProfile.producerNote aiProfile.confidence').lean();

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} undecided published-suspect rows\n`);

  const downgrade = rows.filter((w) => noteAssertsProducer(w.aiProfile?.producerNote, w.producer));
  const keep = rows.length - downgrade.length;

  console.log(`note asserts a REAL PRODUCER → suspect becomes unknown : ${downgrade.length}`);
  console.log(`note names a brand, or is category-only → left alone   : ${keep}\n`);

  for (const w of downgrade.slice(0, 25)) {
    console.log(`   ${w._id} ${w.producer}`);
    console.log(`      "${(w.aiProfile?.producerNote || '').slice(0, 130)}"`);
  }
  if (downgrade.length > 25) console.log(`   … and ${downgrade.length - 25} more`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  for (const w of downgrade) {
    await WineDefinition.updateOne(
      { _id: w._id },
      { $set: { 'aiProfile.producerSuspect': false, 'aiProfile.producerUnknown': true } }
    );
    done++;
  }
  console.log(`\nreclassified: ${done}`);

  const left = await WineDefinition.countDocuments({
    'aiProfile.producerSuspect': true, 'aiProfile.description': { $ne: null },
    'aiProfile.heldAt': null, 'aiProfile.suspectDecision': { $in: [null, undefined] },
    nonWine: { $ne: true },
  });
  console.log(`published suspects still awaiting judgement: ${left}`);

  await mongoose.disconnect();
  console.log('Done.');
})().catch((e) => { console.error('Failed:', e); process.exit(1); });
