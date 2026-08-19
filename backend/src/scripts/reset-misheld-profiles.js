/**
 * reset-misheld-profiles.js
 *
 * Somm ticket 6a855285 (2026-08-19): the hold queue's bulk is data-rich wines
 * held only because the generator didn't recognise the BOTTLING, plus rows
 * whose flags misfired on known houses (pre-R7/R8 prompt semantics). Their
 * explicit requirement, honoured here: this must be a MIGRATION, not a pile
 * of MCP confirms — review_held_profile stamps profileReviewedAt and claims
 * a curator adjudicated the row, and ~500 unread rows must not put false
 * provenance into the audit trail the September scaling review reads.
 *
 * Two mechanical, conservative actions — nothing claims review:
 *
 *  (a) HELD rows that are either DATA-SUFFICIENT (identityDataSufficient:
 *      a place axis + a what axis — the class the refined gate now
 *      publishes) or whose producer_note matches the KNOWN-HOUSE shape
 *      ("X is a known/genuine/real/documented … but/however …") get their
 *      aiProfile fully cleared → back to the enrichment pool for a FRESH
 *      generation under the fixed prompts and gate. No stamp, no claim;
 *      if the new generation still doubts, it holds again with current
 *      semantics.
 *  (b) PUBLISHED producer-suspect rows whose note matches the KNOWN-HOUSE
 *      shape get ONLY the suspect flag cleared (the owner-visible caveat
 *      was a misfire); producerNote stays. Rows whose note NAMES an
 *      alternative ("X is a range of Y", "X is actually Y") are NEVER
 *      touched — that is the correct-suspect class (their category 2).
 *
 * Re-enrichment of the (a) rows is NOT triggered here: run the incremental
 * enrichment job afterwards in CAPPED batches with an Anthropic balance
 * check first (reference_ai_credit_balance) — ~500 generations is real spend.
 *
 * Dry-run by default; --apply writes a JSON backup first.
 *
 * Usage:
 *   node src/scripts/reset-misheld-profiles.js            # dry run
 *   node src/scripts/reset-misheld-profiles.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { identityDataSufficient } = require('../services/enrichmentJob');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

// "The producer is real, only the bottling is unverified" — the misfire shape.
// Deliberately requires BOTH the vouching word and the but-clause, so
// alternative-naming notes ("Arcane is a range of Xavier Vignon") never match.
const KNOWN_HOUSE_RX =
  /\b(?:is|are)\s+(?:a|an|the)?\s*(?:well[- ]?known|known|genuine|real|documented|established|respected|recognised|recognized)\b[\s\S]{0,120}?\b(?:but|however|though|yet)\b/i;

// Notes that NAME an alternative — the correct-suspect class, never touched.
const ALTERNATIVE_RX = /\b(?:is|are)\s+(?:actually|really)?\s*(?:a|the)?\s*(?:range|line|label|brand|cuv[ée]e)\s+of\b|\bbelongs?\s+to\b/i;

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const stats = { heldScanned: 0, heldReset: { data_sufficient: 0, known_house_note: 0 }, suspectScanned: 0, suspectCleared: 0, alternativeSkipped: 0 };
  const backup = [];
  const now = new Date();

  // (a) Held rows → clear-and-requeue when mechanically safe.
  const held = await WineDefinition.find({
    nonWine: { $ne: true },
    'aiProfile.heldAt': { $ne: null },
  }).select('name producer appellation region type grapes aiProfile profileReviewedAt').lean();
  for (const w of held) {
    stats.heldScanned += 1;
    // A row a human already decided (confirm) is theirs — never reopened here.
    if (w.profileReviewedAt && w.aiProfile.generatedAt
        && new Date(w.profileReviewedAt) >= new Date(w.aiProfile.generatedAt)) continue;
    const note = w.aiProfile.producerNote || '';
    if (ALTERNATIVE_RX.test(note)) { stats.alternativeSkipped += 1; continue; }
    const sufficient = identityDataSufficient(w);
    const knownHouse = KNOWN_HOUSE_RX.test(note);
    if (!sufficient && !knownHouse) continue;
    const why = sufficient ? 'data_sufficient' : 'known_house_note';
    stats.heldReset[why] += 1;
    if (stats.heldReset.data_sufficient + stats.heldReset.known_house_note <= 25) {
      console.log(`${tag} requeue [${why}] "${w.name}" — ${w.producer} (${w.aiProfile.heldReason || 'legacy'}, conf ${w.aiProfile.confidence ?? 'null'})`);
    }
    backup.push({ _id: String(w._id), action: 'requeue', aiProfile: w.aiProfile });
    if (APPLY) {
      await WineDefinition.updateOne(
        { _id: w._id },
        {
          $set: {
            aiProfile: {
              body: null, tannin: null, acidity: null, sweetness: null,
              flavors: [], foodPairings: [], description: null,
              confidence: null, producerSuspect: false, producerUnknown: false,
              producerNote: null, model: null, source: 'ai',
              generatedAt: null, heldAt: null, heldReason: null,
            },
            updatedAt: now,
          },
        }
      );
    }
  }

  // (b) Published suspect rows → clear only the misfired flag.
  const suspects = await WineDefinition.find({
    nonWine: { $ne: true },
    'aiProfile.heldAt': null,
    'aiProfile.producerSuspect': true,
    'aiProfile.description': { $ne: null },
  }).select('name producer aiProfile.producerNote aiProfile.producerSuspect').lean();
  for (const w of suspects) {
    stats.suspectScanned += 1;
    const note = w.aiProfile.producerNote || '';
    if (ALTERNATIVE_RX.test(note)) { stats.alternativeSkipped += 1; continue; }
    if (!KNOWN_HOUSE_RX.test(note)) continue;
    stats.suspectCleared += 1;
    if (stats.suspectCleared <= 15) {
      console.log(`${tag} unflag "${w.name}" — ${w.producer} | note: ${note.slice(0, 80)}`);
    }
    backup.push({ _id: String(w._id), action: 'unflag', producerNote: note });
    if (APPLY) {
      await WineDefinition.updateOne({ _id: w._id }, { $set: { 'aiProfile.producerSuspect': false, updatedAt: now } });
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `misheld-reset-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} rows → ${file} (container /tmp is ephemeral — copy it off)`);
  }

  console.log(`\nSummary: held scanned ${stats.heldScanned} → ${APPLY ? 'requeued' : 'would requeue'} ${stats.heldReset.data_sufficient + stats.heldReset.known_house_note} ` +
    `(data_sufficient: ${stats.heldReset.data_sufficient}, known_house_note: ${stats.heldReset.known_house_note}); ` +
    `published suspects scanned ${stats.suspectScanned} → ${APPLY ? 'unflagged' : 'would unflag'} ${stats.suspectCleared}; ` +
    `alternative-naming rows skipped ${stats.alternativeSkipped} (the correct-suspect class).`);
  if (APPLY) console.log('Next: CHECK THE ANTHROPIC BALANCE, then run incremental enrichment in capped batches (limit ≤150) until the requeued rows regenerate under the refined gate.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Reset misheld failed:', err); process.exit(1); });
