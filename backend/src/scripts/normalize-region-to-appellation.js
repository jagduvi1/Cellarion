/**
 * Normalize wine.region to the appellation's own region — the batch half of
 * the region-granularity canon (Johan, 2026-08-16 / ticket 6a8162c5).
 *
 * CANON: when a wine's appellation itself names a region the taxonomy has
 * (appellation "Hunter Valley", and a Hunter Valley Region doc under the same
 * country), the region field holds THAT region — the most specific
 * granularity — not a parent ("New South Wales") or the producer's home
 * region. The mint-time half is services/findOrCreateWine.regionForAppellation
 * (all four mint surfaces); this script folds the rows that predate it.
 * Measured on prod 2026-08-16: 506 published rows, led by
 * California→Napa Valley (51), South Australia→Barossa Valley (25),
 * New South Wales→Hunter Valley (24) — plus 6 rows whose region was null
 * while the appellation named a known region.
 *
 * SHARED RESOLUTION, by construction: each row is resolved through the SAME
 * regionForAppellation the mint path uses, so this script and the chokepoint
 * cannot drift. MATCH-ONLY there and here — an appellation string never
 * mints a Region (appellations are unvalidated free text).
 *
 * Rows skipped: no appellation, nonWine (quarantine is not churned), no
 * country, appellation matching no Region in that country, and any
 * country+key with DUPLICATE region docs (reported loudly — findOne would
 * pick one arbitrarily, and taxonomy dedup should have removed these).
 *
 * Region is NOT part of normalizedKey/canonicalKey/slug, so a plain
 * updateOne is safe (no hook-managed derivations move). Search docs DO
 * denormalize the region name for both wines and bottles → --apply reindexes
 * the changed wines and their bottles. Region is also in the embedding text →
 * run an incremental embed job afterwards (reminder printed).
 *
 * Dry-run by default (prints the grouped rewrite plan). --apply writes.
 *
 *   docker exec cellarion-backend node src/scripts/normalize-region-to-appellation.js
 *   docker exec cellarion-backend node src/scripts/normalize-region-to-appellation.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Region = require('../models/Region');
const Bottle = require('../models/Bottle');
require('../models/Country');
require('../models/Grape');
const { regionForAppellation } = require('../services/findOrCreateWine');
const searchService = require('../services/search');
const { logAudit } = require('../services/audit');

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  // Region name lookup for reporting, and the duplicate-key guard: a
  // country holding TWO regions under one normalized name/synonym makes
  // regionForAppellation's findOne an arbitrary pick — those keys are held
  // out and reported instead of rewritten.
  const allRegions = await Region.find({})
    .select('name normalizedName normalizedSynonyms country').lean();
  const regionName = new Map(allRegions.map((r) => [String(r._id), r.name]));
  const keyOwners = new Map(); // `${countryId}:${key}` -> Set of region ids
  for (const r of allRegions) {
    for (const key of [r.normalizedName, ...(r.normalizedSynonyms || [])]) {
      if (!key) continue;
      const k = `${String(r.country)}:${key}`;
      if (!keyOwners.has(k)) keyOwners.set(k, new Set());
      keyOwners.get(k).add(String(r._id));
    }
  }
  const duplicateKeys = new Set(
    [...keyOwners.entries()].filter(([, ids]) => ids.size > 1).map(([k]) => k)
  );

  const { normalizeString } = require('../utils/normalize');
  const cursor = WineDefinition.find({
    appellation: { $nin: [null, ''] },
    nonWine: { $ne: true },
  }).select('name producer appellation region country').cursor();

  const changes = [];   // { id, name, producer, appellation, fromId, from, to, toId }
  const ambiguous = []; // rows held out by the duplicate-key guard
  for await (const w of cursor) {
    if (!w.country) continue;
    const key = normalizeString(w.appellation);
    if (!key) continue;
    if (duplicateKeys.has(`${String(w.country)}:${key}`)) {
      ambiguous.push(`${w.producer || '(no producer)'} — ${w.name} [ap "${w.appellation}"]`);
      continue;
    }
    const target = await regionForAppellation(w.appellation, w.country);
    if (!target) continue;
    if (String(w.region || '') === String(target._id)) continue;
    changes.push({
      id: w._id,
      name: w.name,
      producer: w.producer,
      appellation: w.appellation,
      from: w.region ? (regionName.get(String(w.region)) || String(w.region)) : '(none)',
      to: target.name,
      toId: target._id,
    });
  }

  // Grouped plan, biggest rewrites first.
  const groups = new Map();
  for (const c of changes) {
    const k = `${c.from} → ${c.to}  (ap "${c.appellation}")`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${changes.length} rows to rewrite, ${groups.size} distinct region pairs`);
  for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  if (ambiguous.length) {
    console.log(`\nHELD (duplicate region key in taxonomy — fix the taxonomy first): ${ambiguous.length}`);
    for (const line of ambiguous.slice(0, 20)) console.log(`  ${line}`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const c of changes) {
    await WineDefinition.updateOne(
      { _id: c.id },
      { $set: { region: c.toId, updatedAt: new Date() } }
    );
    logAudit(null, 'admin.wine.region_normalize', { type: 'wine', id: c.id },
      { appellation: c.appellation, from: c.from, to: c.to });
    await searchService.indexWine(c.id);
    written++;
  }

  // Bottle search docs denormalize regionName — one bulk pass at the end.
  const wineIds = changes.map((c) => c.id);
  if (wineIds.length) {
    const bottleIds = await Bottle.distinct('_id', { wineDefinition: { $in: wineIds } });
    if (bottleIds.length) await searchService.bulkIndexBottles(bottleIds);
    console.log(`\nReindexed ${wineIds.length} wines and ${bottleIds.length} bottles.`);
  }
  console.log(`Applied ${written} region rewrites.`);
  console.log('Region is part of the embedding text — start an incremental embed job to refresh Qdrant.');
  await mongoose.disconnect();
})();
