/**
 * Re-derive normalizedName/normalizedSynonyms for every Appellation doc using
 * normalizeAppellationKey (audit 2026-07-29 A2).
 *
 * Docs created before the appellation system (#858) carry keys computed with
 * plain normalizeString, which DELETES hyphens — so "Châteauneuf-du-Pape" is
 * stored as 'chateauneufdupape' while every lookup now folds to
 * 'chateauneuf du pape'. Those legacy docs are unmatchable by the resolver,
 * keep appearing in the unmatched review queue next to the doc that nominally
 * covers them, and a re-run of the seed script could mint a competing twin.
 * The model has no hook that re-derives normalizedName from name (only
 * synonyms are hook-maintained), so a one-off backfill is the fix.
 *
 * Collision guard: if two docs in the same country fold to the same NEW key
 * (the unique index would reject the second), both are SKIPPED and reported —
 * that pair needs a human merge, not a silent overwrite.
 *
 * Dry-run by default; --apply to write.
 *
 *   docker exec cellarion-backend node src/scripts/backfill-appellation-keys.js
 *   docker exec cellarion-backend node src/scripts/backfill-appellation-keys.js --apply
 */

const mongoose = require('mongoose');
const Appellation = require('../models/Appellation');
const { normalizeAppellationKey } = require('../utils/normalize');

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const docs = await Appellation.find({}).select('name normalizedName synonyms normalizedSynonyms country').lean();

  // country → newKey → [docIds] for the collision guard
  const byCountryKey = new Map();
  for (const d of docs) {
    const key = normalizeAppellationKey(d.name || '');
    const ck = `${d.country}:${key}`;
    if (!byCountryKey.has(ck)) byCountryKey.set(ck, []);
    byCountryKey.get(ck).push(String(d._id));
  }

  const ops = [];
  let unchanged = 0, collisions = 0;
  for (const d of docs) {
    const newName = normalizeAppellationKey(d.name || '');
    const newSyns = (d.synonyms || []).map(s => normalizeAppellationKey(s)).filter(Boolean);
    const synsChanged = JSON.stringify(newSyns.length ? newSyns : undefined) !== JSON.stringify(d.normalizedSynonyms?.length ? d.normalizedSynonyms : undefined);
    if (d.normalizedName === newName && !synsChanged) { unchanged += 1; continue; }

    const twins = byCountryKey.get(`${d.country}:${newName}`) || [];
    if (twins.length > 1) {
      collisions += 1;
      console.log(`  COLLISION (needs manual merge): "${d.name}" [${d._id}] — ${twins.length} docs in this country fold to "${newName}"`);
      continue;
    }
    console.log(`  ~ "${d.name}": "${d.normalizedName}" → "${newName}"${synsChanged ? ' (+synonyms)' : ''}`);
    ops.push({ updateOne: {
      filter: { _id: d._id },
      update: newSyns.length
        ? { $set: { normalizedName: newName, normalizedSynonyms: newSyns } }
        : { $set: { normalizedName: newName }, $unset: { normalizedSynonyms: '' } },
    } });
  }

  console.log(`[backfill-appellation-keys] ${apply ? 'APPLY' : 'DRY-RUN'} docs=${docs.length} toFix=${ops.length} unchanged=${unchanged} collisions=${collisions}`);
  if (apply && ops.length > 0) {
    const res = await Appellation.bulkWrite(ops, { ordered: false });
    console.log(`[backfill-appellation-keys] modified=${res.modifiedCount}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
