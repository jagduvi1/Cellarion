/**
 * migrate-classification-taxonomy.js
 *
 * Classification moves from free text to a curated taxonomy
 * (models/Classification, support ticket 2026-10-29). This script:
 *
 *   1. seeds the taxonomy from data/classifications.json (--apply only);
 *   2. maps every wine's legacy `classification` string onto taxonomy rows —
 *      "Spätlese, VDP.Grosse Lage" becomes two — and rewrites the string in
 *      the canonical spelling; ride-along words are dropped ("Kabinett
 *      trocken" is Kabinett); a value no row answers is left untouched and
 *      listed, never guessed;
 *   3. backfills wines with no classification whose NAME states a tier that
 *      is law or custom in their country (a Spätlese in Germany, a Riserva
 *      in Italy, a Gran Reserva in Spain, a Cru Bourgeois in Bordeaux, an
 *      LBV among Ports …) — services/classificationOps.detectFromName;
 *      Burgundy's and Alsace's "Premier Cru" stay in the appellation, as the
 *      registry rule says.
 *
 * The AI profile snapshot moves along with a changed string the same way
 * normalize-classification-tiers.js does, so no paid regeneration is queued.
 *
 * Dry-run by default: prints every mapping and a tally of unresolved values.
 * On --apply: NDJSON backup of each row's old values first
 * (scripts/lib/backupLog), then the writes.
 *
 * Usage:
 *   node src/scripts/migrate-classification-taxonomy.js            # dry run
 *   node src/scripts/migrate-classification-taxonomy.js --apply    # execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Classification = require('../models/Classification');
const Country = require('../models/Country');
require('../models/Region');
const { profileInputsSnapshot } = require('../services/enrichmentJob');
const { createBackupLog } = require('./lib/backupLog');
const ops = require('../services/classificationOps');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

const FIELDS = 'name producer appellation classification classifications country region type aiProfile.inputsSnapshot canary nonWine';

/**
 * An in-memory resolver over seed + existing rows, so a dry run needs no
 * taxonomy writes. Rows carry `country` as a NAME here (the caller maps
 * ids). lookup(name, countryName) prefers the row of the wine's country when
 * a word is a tier in two systems, then a country-less row.
 */
function buildIndex(rows) {
  const byKey = new Map();
  const add = (k, r) => { if (!k) return; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); };
  for (const r of rows) {
    add(normalizeString(r.name), r);
    for (const s of r.synonyms || []) add(normalizeString(s), r);
  }
  return (name, countryName = null) => {
    const list = byKey.get(normalizeString(name || ''));
    if (!list) return null;
    return (countryName && list.find((r) => r.country === countryName)) || list.find((r) => !r.country) || list[0];
  };
}

/**
 * Plan one wine: { names, unresolved, source } or null when nothing changes.
 * `lookup` maps a display name or synonym (+ the wine's country name) to a
 * row { name, kind, country, _id? }.
 */
function planWine(w, lookup) {
  const countryName = (w.country && w.country.name) || null;
  const existing = (w.classification || '').trim();
  if (existing) {
    const parts = ops.splitClassificationString(existing);
    const rows = []; const unresolved = [];
    for (const p of parts) {
      const r = lookup(p, countryName) || lookup(ops.stripNoise(p), countryName);
      if (r) { if (!rows.some((x) => x.name === r.name)) rows.push(r); continue; }
      if (ops.stripNoise(p) === '') continue; // a ride-along word beside a tier
      unresolved.push(p);
    }
    if (unresolved.length) return { names: [], unresolved, source: 'legacy' };
    if (!rows.length) return { names: [], unresolved: parts, source: 'legacy' }; // nothing but ride-along words
    return { names: rows.map((r) => r.name), unresolved: [], source: 'legacy', rows };
  }
  if ((w.classifications || []).length) return null;
  const detected = ops.detectFromName({ name: w.name, countryName, regionName: w.region && w.region.name, appellation: w.appellation, type: w.type });
  if (!detected.length) return null;
  const rows = detected.map((n) => lookup(n, countryName)).filter(Boolean);
  if (rows.length !== detected.length) return { names: [], unresolved: detected.filter((n) => !lookup(n, countryName)), source: 'name' };
  return { names: rows.map((r) => r.name), unresolved: [], source: 'name', rows };
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  if (APPLY) {
    const seeded = await ops.seedClassifications();
    console.log(`${tag} taxonomy seeded: ${seeded.created} created, ${seeded.updated} updated`);
  }
  const countryNameById = new Map((await Country.find({}).select('name').lean()).map((c) => [String(c._id), c.name]));
  const seed = require('../data/classifications.json');
  const dbRows = (await Classification.find({}).lean()).map((r) => ({ ...r, country: r.country ? (countryNameById.get(String(r.country)) || null) : null }));
  const lookup = buildIndex(APPLY ? dbRows : [...dbRows, ...seed.filter((s) => !dbRows.some((r) => r.normalizedName === normalizeString(s.name)))]);

  const wines = await WineDefinition.find({ canary: { $ne: true }, nonWine: { $ne: true } }).select(FIELDS).populate('country', 'name').populate('region', 'name').lean();
  const stats = { scanned: wines.length, legacyMapped: 0, legacyUnresolved: 0, fromName: 0, unchanged: 0, snapshotMoved: 0 };
  const unresolved = new Map();
  const tally = new Map();
  // A tier sitting in the APPELLATION field ("Großes Gewächs", "Chianti
  // Classico Riserva") is reported, not rewritten: an appellation change
  // re-keys the wine (normalizedKey) and reindexes it, which is the admin
  // form's job — the curation pass takes this list there.
  const tierInAppellation = [];
  const backup = createBackupLog('classification-taxonomy');
  let shown = 0;
  for (const w of wines) {
    const countryName = (w.country && w.country.name) || null;
    if (w.appellation) {
      const d = ops.detectFromName({ name: w.appellation, countryName, regionName: w.region && w.region.name, appellation: w.appellation, type: w.type }, { withRest: true });
      if (d.names.length) tierInAppellation.push({ id: String(w._id), name: w.name, producer: w.producer, appellation: w.appellation, tiers: d.names, rest: d.rest.replace(/^[\s,\-–—:·]+|[\s,\-–—:·]+$/g, '') });
    }
    const plan = planWine(w, lookup);
    if (!plan) { stats.unchanged += 1; continue; }
    if (plan.unresolved.length) {
      stats.legacyUnresolved += 1;
      for (const u of plan.unresolved) unresolved.set(u, (unresolved.get(u) || 0) + 1);
      continue;
    }
    const nextString = ops.classificationString(plan.rows);
    if (plan.source === 'legacy') stats.legacyMapped += 1; else stats.fromName += 1;
    for (const n of plan.names) tally.set(n, (tally.get(n) || 0) + 1);
    if (shown < 80) { console.log(`${tag} ${plan.source === 'name' ? 'from name' : 'legacy   '} "${w.name}" — ${w.producer}: "${w.classification || ''}" → [${plan.names.join(' | ')}]`); shown += 1; }
    if (!APPLY) continue;
    const ids = plan.rows.map((r) => r._id).filter(Boolean);
    if (ids.length !== plan.rows.length) throw new Error('taxonomy row without an id after seeding — abort');
    const $set = { classifications: ids, classification: nextString, updatedAt: new Date() };
    const stored = w.aiProfile && w.aiProfile.inputsSnapshot;
    if (stored && nextString !== w.classification && stored === profileInputsSnapshot(w)) {
      $set['aiProfile.inputsSnapshot'] = profileInputsSnapshot({ ...w, classification: nextString });
      stats.snapshotMoved += 1;
    }
    backup.append({ _id: String(w._id), classification: w.classification || null, classifications: (w.classifications || []).map(String), inputsSnapshot: stored || null });
    await WineDefinition.updateOne({ _id: w._id }, { $set });
  }
  if (APPLY) backup.report();
  console.log(`\nSummary: ${stats.scanned} wines scanned; legacy strings mapped ${stats.legacyMapped}, unresolved ${stats.legacyUnresolved}; filled from the name ${stats.fromName}; unchanged ${stats.unchanged}; profile snapshots moved ${stats.snapshotMoved}.`);
  console.log('\nRows assigned (wines per classification):');
  for (const [n, c] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}  ${n}`);
  if (unresolved.size) {
    console.log('\nValues no taxonomy row answers (left untouched — add a row or clear the field):');
    for (const [v, n] of [...unresolved.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${v}`);
  }
  if (tierInAppellation.length) {
    console.log(`\nA tier in the appellation field (${tierInAppellation.length} wines — not rewritten; fix through the admin form, which re-keys the wine):`);
    for (const t of tierInAppellation) console.log(`  ${t.id}  "${t.name}" — ${t.producer}: appellation "${t.appellation}" → "${t.rest || ''}" + [${t.tiers.join(' | ')}]`);
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Classification migration failed:', err); process.exit(1); });
}
module.exports = { planWine, buildIndex, FIELDS };
