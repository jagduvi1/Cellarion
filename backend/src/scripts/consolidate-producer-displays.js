/**
 * Consolidate producer DISPLAY splits across the registry — the productized
 * form of the 2026-08-14 cleanup (130 clusters → 22, 199 rows), for the
 * periodic sweep the display-split watchdog metric rings for.
 *
 * A "display split" is one estate stored under several producer strings that
 * all fold to the same comparison key: "Philipp Kuhn" / "Weingut Philipp
 * Kuhn" / "Felton Road Wines Ltd" vs "Felton Road". The mint-time resolver
 * (services/producerSpelling.js) prevents NEW splits; this script folds the
 * ones that predate it — or that its deliberate ambiguity guards let through.
 *
 * TARGET RULE (Johan, 2026-08-14 — "fullest estate form", hardened against
 * the single-outlier trap):
 *   1. a spelling with a legal suffix (Ltd, GmbH, S.L.) is never canonical
 *   2. prefer a spelling carrying an estate TITLE (Weingut/Domaine/Château/…)
 *   3. otherwise majority, ties → the spelling whose earliest wine is oldest
 *   4. a 1-v-1 tie neither rule settles is a COIN FLIP → held for a human
 *
 * HELD, never auto-consolidated (each guard caught a real different-estate
 * pair on prod): clusters spanning >1 country (Taylors AU=Clare Valley vs
 * PT=Port) · different CORE tokens · two DIFFERENT estate titles (Domaine de
 * Bellevue vs Château Bellevue) · sentinel producers ("Unknown") ·
 * unresolvable ties (Stag's Leap Wine Cellars vs Stags Leap — two real Napa
 * estates).
 *
 * Writes via doc.save() so the model hooks own canonicalKey, slug
 * regeneration (old slug preserved in previousSlugs — no URL breaks) and the
 * verifiedChecks invalidation a producer change must trigger. normalizedKey
 * is NOT hook-maintained and is UNIQUE, so it is set explicitly and every new
 * key is pre-checked for collisions; a blocked row is reported, not forced.
 *
 * Dry-run by default. --apply writes, reindexes each changed wine, and
 * reminds about the incremental embed run (producer is in the embedding
 * text). Check for an in-flight deploy first: a backend recreate kills the
 * embed job this script asks you to start.
 *
 *   docker exec cellarion-backend node src/scripts/consolidate-producer-displays.js
 *   docker exec cellarion-backend node src/scripts/consolidate-producer-displays.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
require('../models/Region');
require('../models/Grape');
const { normalizeString, generateWineKey, isIdentitySentinel } = require('../utils/normalize');
const { computeCanonicalKey, producerSegment } = require('../utils/wineIdentity');
const { logAudit } = require('../services/audit');

// Estate-title and decoration vocabularies for the TARGET rule only (bucket
// membership itself comes from producerSegment — one fold, shared with the
// mint-time resolver). Title tokens mark "the fullest estate form"; legal
// tokens disqualify a spelling; the rest exist so ties are recognized as
// decoration-only. Widen from measured evidence, not speculation.
const TITLES = new Set([
  'weingut', 'weinhaus', 'schloss', 'kellerei', 'domaine', 'domaines', 'maison',
  'chateau', 'clos', 'champagne', 'cave', 'caves', 'bodega', 'bodegas', 'vina',
  'hacienda', 'celler', 'quinta', 'tenuta', 'tenute', 'cantina', 'cantine',
  'fattoria', 'podere', 'castello', 'azienda', 'agricola', 'casa',
]);
const LEGAL = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'gmbh', 'ag',
  'sa', 'sas', 'sarl', 'srl', 'spa', 'sl', 'bv', 'nv', 'pty', 'corp',
  'corporation', 'ab', 'oy', 'as', 'kg', 'kft',
]);
const DECOR = new Set([
  'wines', 'wine', 'winery', 'wineries', 'vineyard', 'vineyards', 'estate',
  'estates', 'cellars', 'cellar', 'company', 'co', 'vignobles', 'vitivinicola',
]);
const ARTICLES = new Set(['the', 'le', 'la', 'les', 'de', 'du', 'des', 'di', 'el', 'il', 'y', 'e', 'et', 'and', 'a', 'l', 'd']);

const toks = (s) => normalizeString(s).split(' ').filter(Boolean);
const coreOf = (s) => toks(s).filter((t) => !TITLES.has(t) && !LEGAL.has(t) && !DECOR.has(t) && !ARTICLES.has(t)).sort().join(' ');
const titlesOf = (s) => [...new Set(toks(s).filter((t) => TITLES.has(t)))].sort().join(' ');
const hasLegal = (s) => toks(s).some((t) => LEGAL.has(t));

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const wines = await WineDefinition.find({ pendingIdentity: { $ne: true } })
    .select('name producer appellation country normalizedKey canonicalKey slug nonWine createdAt verifiedChecks crossChecksCleared');
  const countries = await Country.find({}).select('name').lean();
  const countryName = new Map(countries.map((c) => [String(c._id), c.name]));

  // ---- bucket by producer key + country ---------------------------------
  const buckets = new Map();
  for (const w of wines) {
    const seg = producerSegment(w.producer || '');
    if (!seg) continue;
    const key = `${seg}|${w.country || ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(w);
  }

  // Cross-country twin detection needs the segment-only view too.
  const segCountries = new Map();
  for (const key of buckets.keys()) {
    const seg = key.split('|')[0];
    segCountries.set(seg, (segCountries.get(seg) || 0) + 1);
  }

  const safe = [];
  const flagged = [];
  for (const [key, ws] of buckets) {
    const seg = key.split('|')[0];
    const spellings = new Map();
    for (const w of ws) {
      const s = String(w.producer).trim().replace(/\s+/g, ' ');
      if (!spellings.has(s)) spellings.set(s, { count: 0, oldest: null, wines: [] });
      const e = spellings.get(s);
      e.wines.push(w);
      // Quarantined rows are rewritten for consistency but get no vote —
      // mirror services/producerSpelling.js.
      if (!w.nonWine) {
        e.count += 1;
        if (e.oldest === null || w.createdAt < e.oldest) e.oldest = w.createdAt;
      }
    }
    if (spellings.size < 2) continue;

    const forms = [...spellings.keys()];
    const country = countryName.get(String(ws[0].country)) || '?';
    const reason =
      forms.some((f) => isIdentitySentinel(f)) ? 'sentinel producer'
      : segCountries.get(seg) > 1 ? 'same producer key exists in another country — check for different estates'
      : new Set(forms.map(coreOf)).size > 1 ? 'core name differs, not just decoration'
      : new Set(forms.map(titlesOf).filter(Boolean)).size > 1 ? 'two DIFFERENT estate titles — probably different estates'
      : null;
    if (reason) { flagged.push({ key, country, spellings, reason }); continue; }

    // ---- target selection (the rule block above) ------------------------
    let cands = forms;
    const clean = cands.filter((f) => !hasLegal(f));
    const legalDecided = clean.length > 0 && clean.length < cands.length;
    if (clean.length) cands = clean;
    const titled = cands.filter((f) => titlesOf(f));
    const titleDecided = titled.length > 0 && titled.length < cands.length;
    if (titled.length) cands = titled;
    cands.sort((a, b) =>
      (spellings.get(b).count - spellings.get(a).count) ||
      ((spellings.get(a).oldest ?? Infinity) - (spellings.get(b).oldest ?? Infinity)));
    if (!legalDecided && !titleDecided && cands.length > 1 &&
        spellings.get(cands[0]).count === spellings.get(cands[1]).count) {
      flagged.push({ key, country, spellings, reason: 'tie with no legal/title rule to break it — pick one by hand' });
      continue;
    }
    safe.push({ key, country, target: cands[0], spellings });
  }

  // ---- row-level plan + UNIQUE-key collision pre-check ------------------
  const planned = [];
  for (const g of safe) {
    for (const [sp, e] of g.spellings) {
      if (sp === g.target) continue;
      for (const w of e.wines) {
        if (w.producer === g.target) continue;
        planned.push({
          doc: w, group: g, from: w.producer,
          newKey: generateWineKey(w.name, g.target, w.appellation),
          newCanon: computeCanonicalKey(w.name, g.target, w.appellation),
        });
      }
    }
  }
  const seen = new Map();
  for (const p of planned) {
    if (seen.has(p.newKey)) p.blocked = `intra-batch key clash with ${seen.get(p.newKey)}`;
    else seen.set(p.newKey, String(p.doc._id));
    if (!p.blocked) {
      const holder = await WineDefinition.findOne({ normalizedKey: p.newKey, _id: { $ne: p.doc._id } })
        .select('_id name producer').lean();
      if (holder) p.blocked = `key held by "${holder.name}" / "${holder.producer}" [${holder._id}]`;
    }
  }

  // ---- report -----------------------------------------------------------
  console.log(`===== AUTO-CONSOLIDATE: ${safe.filter((g) => planned.some((p) => p.group === g)).length} clusters, ${planned.length} rows =====`);
  for (const g of safe) {
    const rows = planned.filter((p) => p.group === g);
    if (!rows.length) continue;
    const parts = [...g.spellings.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([s, e]) => `"${s}"x${e.count}`).join('  ');
    console.log(`\n  ${parts}   (${g.country})`);
    console.log(`    => "${g.target}"`);
    for (const p of rows) {
      const notes = [];
      if (p.blocked) notes.push(`BLOCKED: ${p.blocked}`);
      if (p.doc.canonicalKey !== p.newCanon) notes.push('canonicalKey changes');
      const clearances = (p.doc.verifiedChecks || []).length + (p.doc.crossChecksCleared || []).length;
      if (clearances) notes.push(`clears ${clearances} human clearance(s)`);
      console.log(`       ${p.doc._id} ${p.doc.name}${notes.length ? '   [' + notes.join('; ') + ']' : ''}`);
    }
  }
  console.log(`\n===== HELD FOR A HUMAN: ${flagged.length} clusters =====`);
  for (const f of flagged) {
    const parts = [...f.spellings.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([s, e]) => `"${s}"x${e.count}`).join('  ');
    console.log(`  ${parts}   (${f.country})\n      ${f.reason}`);
  }
  const blocked = planned.filter((p) => p.blocked).length;
  console.log(`\n[consolidate-producer-displays] ${apply ? 'APPLY' : 'DRY-RUN'} rows=${planned.length} blocked=${blocked} heldClusters=${flagged.length}`);

  if (!apply) { await mongoose.disconnect(); return; }

  // ---- apply ------------------------------------------------------------
  const searchService = require('../services/search');
  await searchService.initialize();
  let written = 0, failed = 0;
  for (const p of planned) {
    if (p.blocked) continue;
    p.doc.producer = p.group.target;
    p.doc.normalizedKey = p.newKey;
    try {
      await p.doc.save();
      written += 1;
      logAudit(null, 'admin.wine.producer_consolidate',
        { type: 'wine', id: p.doc._id },
        { from: p.from, to: p.group.target });
      await searchService.indexWine(p.doc._id);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL ${p.doc._id}: ${e.code === 11000 ? 'E11000 duplicate key' : e.message}`);
    }
  }
  console.log(`[consolidate-producer-displays] written=${written} failed=${failed} blocked=${blocked}`);
  console.log('NOTE: producer is in the embedding text — start the embedding job (incremental) via POST /api/admin/ai/embed/start.');

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.stack); process.exit(1); });
