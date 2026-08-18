/**
 * rehold-low-confidence-profiles.js
 *
 * Ticket 6a83e765, rollout step: the publication gate (enrichmentJob.
 * shouldHoldProfile — confidence floor + unknown-producer bar, calibrated
 * 2026-08-18) only fires at generation time. Profiles PUBLISHED before the
 * gate shipped stay visible, including the 0.2-confidence rows the somm
 * measured. This applies the same gate, with the same aiConfig thresholds,
 * to already-published rows in a bounded window.
 *
 * Scope guards — every one deliberate:
 *   - --cutoff (default 2026-08-16): only profiles generated in the recent
 *     import/enrichment window. Older published rows predate the gate and
 *     stay for ordinary curation (Johan's scoped-re-hold decision).
 *   - source 'ai' only; curator profiles are never touched.
 *   - profileReviewedAt >= generatedAt rows are skipped: a human already
 *     looked at that profile and chose to publish (the publishSuspect
 *     override) — the gate must not overrule them.
 *
 * A re-held row keeps its meta (confidence/flags/producerNote/model/
 * generatedAt) and loses only the published fields, exactly like a
 * generation-time hold; heldAt/heldReason route it into the admin
 * low-confidence queue for release. Each re-held wine's active (wine,
 * vintage) pairs are re-embedded so Qdrant stops retrieving it by the prose
 * the hold silenced (the audit-2026-08-16 rule; textHash makes it cheap).
 *
 * Owners see "Not yet assessed" on these bottles (v1.124.0), never a blank.
 *
 * Dry-run by default. On --apply: writes a JSON backup of the previous
 * aiProfile values first (restore = re-publish from backup, or a somm
 * release from the admin queue).
 *
 * --reasons=a,b restricts WHICH gate reasons re-hold (default: all). The
 * 2026-08-18 prod run used --reasons=low_confidence,unknown_low_confidence:
 * 57 published producer_suspect rows in the window carried no
 * profileReviewedAt stamp but matched the v1.118 human-release batch
 * (98/102 held profiles published 08-17) — indistinguishable from
 * slipped-through, and they already surface in the admin queue's suspect
 * branch, so the human decides those; the gate's own two confidence classes
 * are what re-holds. Rows matching an excluded reason are counted and
 * reported, never touched.
 *
 * Usage:
 *   node src/scripts/rehold-low-confidence-profiles.js                 # dry run
 *   node src/scripts/rehold-low-confidence-profiles.js --apply
 *   node src/scripts/rehold-low-confidence-profiles.js --cutoff=2026-08-01
 *   node src/scripts/rehold-low-confidence-profiles.js --reasons=low_confidence,unknown_low_confidence --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const aiConfig = require('../config/aiConfig');
const { shouldHoldProfile } = require('./../services/enrichmentJob');
const { embedSinglePair } = require('../services/embeddingJob');

const APPLY = process.argv.includes('--apply');
const cutoffArg = (process.argv.find((a) => a.startsWith('--cutoff=')) || '').slice('--cutoff='.length);
const CUTOFF = new Date(cutoffArg || '2026-08-16T00:00:00Z');
const reasonsArg = (process.argv.find((a) => a.startsWith('--reasons=')) || '').slice('--reasons='.length);
const REASONS = reasonsArg ? new Set(reasonsArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const tag = APPLY ? '✔' : '[dry]';

async function run() {
  if (Number.isNaN(CUTOFF.getTime())) throw new Error(`Bad --cutoff date: ${cutoffArg}`);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  await aiConfig.load(); // one-off scripts must load the DB-backed config themselves
  const { enrichmentHoldConfidenceFloor: floor, enrichmentHoldUnknownConfidenceBar: unknownBar } = aiConfig.get();
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}`);
  console.log(`Gate: floor<${floor}, unknown<${unknownBar}; window: generatedAt >= ${CUTOFF.toISOString()}\n`);

  const rows = await WineDefinition.find({
    nonWine: { $ne: true },
    'aiProfile.generatedAt': { $gte: CUTOFF },
    'aiProfile.description': { $ne: null },
    'aiProfile.heldAt': null,
    'aiProfile.source': { $ne: 'curator' },
  }).select('name producer aiProfile profileReviewedAt').lean();

  const stats = { scanned: rows.length, reheld: 0, reviewedSkipped: 0, byReason: {} };
  const backup = [];
  const now = new Date();
  let shown = 0;

  for (const w of rows) {
    // A human reviewed this exact profile and chose to publish — never overrule.
    if (w.profileReviewedAt && w.aiProfile.generatedAt
        && new Date(w.profileReviewedAt) >= new Date(w.aiProfile.generatedAt)) {
      stats.reviewedSkipped += 1;
      continue;
    }
    const ap = w.aiProfile;
    const reason = shouldHoldProfile(
      {
        producerSuspect: ap.producerSuspect === true,
        producerUnknown: ap.producerUnknown === true,
        description: ap.description,
        confidence: typeof ap.confidence === 'number' ? ap.confidence : null,
      },
      { floor, unknownBar }
    );
    if (!reason) continue;
    if (REASONS && !REASONS.has(reason)) {
      stats.excluded = stats.excluded || {};
      stats.excluded[reason] = (stats.excluded[reason] || 0) + 1;
      continue;
    }

    stats.reheld += 1;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    if (shown < 40) {
      console.log(`${tag} [${reason}] conf=${ap.confidence ?? 'null'} "${w.name}" — ${w.producer}`);
      shown += 1;
    }
    backup.push({ _id: String(w._id), aiProfile: ap });

    if (APPLY) {
      await WineDefinition.updateOne(
        { _id: w._id },
        {
          $set: {
            aiProfile: {
              body: null, tannin: null, acidity: null, sweetness: null,
              flavors: [], foodPairings: [],
              description: null,
              confidence: ap.confidence ?? null,
              producerSuspect: ap.producerSuspect === true,
              producerUnknown: ap.producerUnknown === true,
              producerNote: ap.producerNote ?? null,
              model: ap.model ?? null,
              source: ap.source || 'ai',
              generatedAt: ap.generatedAt,
              heldAt: now,
              heldReason: reason,
            },
            updatedAt: now,
          },
        }
      );
      // Same re-embed rule as a generation-time hold: the silenced prose must
      // leave the vectors too. Best-effort per pair.
      try {
        const vintages = await Bottle.distinct('vintage', { wineDefinition: w._id, status: 'active' });
        for (const v of vintages) {
          await embedSinglePair(w._id, v).catch(() => {});
        }
      } catch (embedErr) {
        console.warn(`  re-embed failed (${w._id}, non-fatal):`, embedErr.message);
      }
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `rehold-profiles-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} previous aiProfile values → ${file}`);
    console.log('(container /tmp is ephemeral — copy it off with docker compose cp)');
  }

  console.log(`\nSummary: ${stats.scanned} published AI profiles in the window, ` +
    `${stats.reheld} ${APPLY ? 're-held' : 'would be re-held'} ` +
    `(${Object.entries(stats.byReason).map(([r, n]) => `${r}: ${n}`).join(', ') || 'none'}), ` +
    `${stats.reviewedSkipped} skipped as human-reviewed` +
    `${stats.excluded ? `, excluded by --reasons: ${Object.entries(stats.excluded).map(([r, n]) => `${r}: ${n}`).join(', ')}` : ''}.`);
  if (APPLY) console.log('Owners of affected bottles now see "Not yet assessed"; release the good ones from Admin → Wines → low-confidence queue.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Re-hold failed:', err); process.exit(1); });
