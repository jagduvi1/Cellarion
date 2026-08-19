/**
 * migrate-suspect-decisions.js — one-off for the suspectDecision split.
 *
 * Until now the published-suspect queue treated `profileReviewedAt` as "this
 * row has been judged". That field is also stamped by applyProfilePatch on any
 * curator profile write, so writing a tasting profile — or fixing a grape list
 * — silently closed the row without anyone answering the question the queue
 * asks, which is whether the PRODUCER is real (somm ticket 6a85f5e8).
 *
 * Classifying the existing stamps:
 *
 *   AI-sourced profile + stamped  → the stamp can only have come from an
 *                                   explicit review_held_profile decision,
 *                                   because nothing else stamps an AI row.
 *                                   Recorded as 'upheld'.
 *   curator-sourced + stamped     → the stamp came from a profile write. The
 *                                   producer question was never answered, so
 *                                   the row RETURNS to the queue (left null).
 *
 * That second rule deliberately returns work to the queue rather than
 * inventing a verdict. A row that was genuinely upheld AND later curated will
 * come back for a second look; re-judging one row is cheap, a fabricated
 * "cannot identify" count is not.
 *
 * Idempotent: only rows with no suspectDecision are touched.
 *
 * Run AFTER deploying the release that contains the new field:
 *   docker exec cellarion-backend node src/scripts/migrate-suspect-decisions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  const col = mongoose.connection.collection('winedefinitions');

  const base = {
    'aiProfile.producerSuspect': true,
    'aiProfile.description': { $ne: null },
    'aiProfile.heldAt': null,
    'aiProfile.suspectDecision': { $in: [null, undefined] },
  };

  const stampedAi = await col.countDocuments({ ...base, profileReviewedAt: { $ne: null }, 'aiProfile.source': { $ne: 'curator' } });
  const stampedCurator = await col.countDocuments({ ...base, profileReviewedAt: { $ne: null }, 'aiProfile.source': 'curator' });
  const unstamped = await col.countDocuments({ ...base, profileReviewedAt: null });
  console.log(`published suspects with no decision recorded:`);
  console.log(`   stamped, AI-sourced      → real decisions, marking upheld : ${stampedAi}`);
  console.log(`   stamped, curator-sourced → profile writes, back to queue  : ${stampedCurator}`);
  console.log(`   never stamped            → already queued, untouched      : ${unstamped}`);

  const res = await col.updateMany(
    { ...base, profileReviewedAt: { $ne: null }, 'aiProfile.source': { $ne: 'curator' } },
    [{
      $set: {
        'aiProfile.suspectDecision': 'upheld',
        // The original review time is the honest decidedAt; no clock invention.
        'aiProfile.suspectDecidedAt': '$profileReviewedAt',
      },
    }]
  );
  console.log(`\nmarked upheld: ${res.modifiedCount}`);

  const nowQueued = await col.countDocuments({
    'aiProfile.producerSuspect': true, 'aiProfile.description': { $ne: null },
    'aiProfile.heldAt': null, 'aiProfile.suspectDecision': { $in: [null, undefined] },
  });
  console.log(`published suspects now awaiting judgement: ${nowQueued}`);

  await mongoose.disconnect();
  console.log('Done.');
})().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
