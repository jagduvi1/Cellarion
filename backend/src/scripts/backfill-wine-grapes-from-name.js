/**
 * backfill-wine-grapes-from-name.js
 *
 * Ticket #2A: registry wines whose grape is explicit in the name
 * ("Felton Road Block 3 Pinot Noir", "Bannockburn Chardonnay") but whose
 * grapes[] is empty — so they silently drop out of the Statistics "by grape"
 * breakdown and the /api/wines?grapes= filter. This tags them using the same
 * name-inference the create path now runs (services/grapeInference.js), which
 * only ever assigns grapes ALREADY in the taxonomy and never mints one.
 *
 * Safe by construction (see grapeInference.js): longest-first span consumption
 * (so "Cabernet Sauvignon" is never also tagged Sauvignon Blanc), word-boundary
 * matching, a minimum synonym length, and a tiny mono-varietal-appellation
 * fallback (Barolo→Nebbiolo, Chablis→Chardonnay — NOT Rioja/Sancerre/Chianti).
 * Wines where nothing matches are left untouched.
 *
 * Dry-run by default. On --apply it writes a JSON backup of every affected row
 * (old grapes) first, then updates + re-indexes Meilisearch per wine (so the
 * grapes= filter reflects the change). NOTE: embeddings are NOT refreshed here
 * — grapes feed the embed text, so run the admin embedding job afterwards to
 * update semantic search (the DB-backed Statistics + Mongo grapes= filter are
 * correct immediately).
 *
 * Usage:
 *   node src/scripts/backfill-wine-grapes-from-name.js            # dry run
 *   node src/scripts/backfill-wine-grapes-from-name.js --apply    # execute
 *   node src/scripts/backfill-wine-grapes-from-name.js --limit=50 # cap (testing)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Grape = require('../models/Grape');
const { buildSurfaceForms, inferGrapeIds } = require('../services/grapeInference');
const { stripProducerName } = require('../utils/producerPrefix');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const tag = APPLY ? '✔' : '[dry]';

// Strip the producer off the name the way findOrCreateWine's step-0 does, so a
// stray producer-in-name row still infers cleanly.
function producerFreeName(name, producer) {
  let n = String(name || '').trim();
  for (let rest = stripProducerName(n, producer); rest; rest = stripProducerName(n, producer)) n = rest;
  return n;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const grapeDocs = await Grape.find({}).select('name normalizedName normalizedSynonyms').lean();
  const forms = buildSurfaceForms(grapeDocs);
  const grapeName = new Map(grapeDocs.map((g) => [String(g._id), g.name]));
  console.log(`Loaded ${grapeDocs.length} grapes → ${forms.length} surface forms.\n`);

  const q = WineDefinition
    .find({ $or: [{ grapes: { $exists: false } }, { grapes: { $size: 0 } }] })
    .select('name producer appellation grapes')
    .lean();
  if (LIMIT) q.limit(LIMIT);
  const wines = await q;

  const stats = { scanned: 0, inferred: 0, noMatch: 0 };
  const backup = [];
  let shown = 0;

  for (const w of wines) {
    stats.scanned += 1;
    const cleanName = producerFreeName(w.name, w.producer);
    const ids = inferGrapeIds(cleanName, w.appellation || '', forms);
    if (ids.length === 0) { stats.noMatch += 1; continue; }
    stats.inferred += 1;

    const names = ids.map((id) => grapeName.get(String(id)) || String(id));
    if (shown < 40) {
      console.log(`${tag} ${w.name}${w.producer ? ' — ' + w.producer : ''}  →  ${names.join(', ')}`);
      shown += 1;
    }
    backup.push({ _id: String(w._id), name: w.name, oldGrapes: (w.grapes || []).map(String) });

    if (APPLY) {
      await WineDefinition.updateOne({ _id: w._id }, { $set: { grapes: ids } });
      // Re-index so the Meili grapes= filter + denormalized bottle rows update.
      try { await require('../services/search').indexWine(w._id); } catch { /* best-effort */ }
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `grape-backfill-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} rows (old grapes) → ${file}`);
  }

  console.log(`\nSummary: ${stats.scanned} empty-grape wines scanned, ${stats.inferred} ${APPLY ? 'tagged' : 'would tag'}, ${stats.noMatch} left untouched (no varietal in name).`);
  if (APPLY) console.log('Next: run the admin embedding job to refresh semantic search (grapes feed the embed text). Statistics + /api/wines grapes= reflect the change now.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
