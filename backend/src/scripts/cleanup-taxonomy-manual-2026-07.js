/**
 * cleanup-taxonomy-manual-2026-07.js
 *
 * The "manual pass" of the 2026-07-18 taxonomy audit — every item here was
 * individually verified against the referencing wines and, where needed,
 * outside sources (see TAXONOMY_AUDIT_2026-07-18.md §4/§6 and the evidence
 * notes inline below). Complements cleanup-taxonomy-2026-07.js.
 *
 * What it does:
 *   1. Wine grape retags (generic Muscat/Malvasía/Trebbiano → the precise
 *      variety where the wine identifies it)
 *   2. Grape merges: schema-design synonym folds (Tinta Roriz→Tempranillo …)
 *      and the garbled "Tanageira"→Rufete
 *   3. Grape renames (Pais→País, Criollas→Criolla, Lasin→Lasina)
 *   4. Display synonyms on canonical grapes (Shiraz on Syrah, …)
 *   5. Region fixes: the seven "X or Y" AI-artifact regions, Stone Farm's
 *      "America"→Lehigh Valley, Rheinland-Pfalz variants, Cava DO,
 *      Barossa/Eden Valley
 *   6. One wine region move (Raisin de Loup → Vin de France)
 *
 * Deliberately NOT touched (unresolvable or product decisions):
 *   - "Anavren" grape (Arba Wine, KZ) — no such variety documented anywhere
 *   - "Alicante" grape (Cairossa blend unverifiable: Grenache vs A. Bouschet)
 *   - "Cabernet" grape (Veneto "Ruare Cabernet" — honest label-level term)
 *   - jhr "Night for Rights Gala" wine (stays under country "Unknown")
 *   - spirits in the registry (product decision)
 *
 * Usage:
 *   node src/scripts/cleanup-taxonomy-manual-2026-07.js           # dry run
 *   node src/scripts/cleanup-taxonomy-manual-2026-07.js --apply   # execute
 *
 * Idempotent — done items are skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const WineDefinition = require('../models/WineDefinition');
const { mergeGrapes, mergeRegions } = require('../services/taxonomyMerge');
const searchService = require('../services/search');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');

// 1. Precise-variety retags, verified per wine (appellation/producer):
//    Collio & Venezia Giulia Malvasia = Malvasia Istriana; Tuscan Vin Santo /
//    Chianti Malvasia = Malvasia Bianca Lunga (del Chianti); Fonseca's wine
//    IS Moscatel Roxo; Manon Virgule's label says Muskateller (= M. Blanc à
//    Petits Grains); Ottomani's Toscana IGT Trebbiano = Trebbiano Toscano.
const WINE_GRAPE_RETAGS = [
  { producer: 'José Maria da Fonseca', wine: 'Moscatel Roxo', from: 'Muscat', to: 'Moscatel Roxo' },
  { producer: 'Manon Virgule', wine: 'Tarantella Pinot Blanc Grüner Veltliner Muskateller', from: 'Muscat', to: 'Muscat Blanc à Petits Grains' },
  { producer: 'Sturm', wine: 'Malvazia', from: 'Malvasía', to: 'Malvasia Istriana' },
  { producer: 'Paraschos', wine: 'Orange One', from: 'Malvasía', to: 'Malvasia Istriana' },
  { producer: 'Jermann', wine: 'Vintage Tunina', from: 'Malvasía', to: 'Malvasia Istriana' },
  { producer: 'Verrazzano', wine: 'Ser Chiaro', from: 'Malvasía', to: 'Malvasia del Chianti' },
  { producer: 'Harvey Nichols', wine: 'Vin Santo Bianco dell\'Empolese', from: 'Malvasía', to: 'Malvasia del Chianti' },
  { producer: 'Fattoria Selvapiana', wine: 'Vin Santo dei Colli della Toscana Centrale', from: 'Malvasía', to: 'Malvasia del Chianti' },
  { producer: 'Ottomani SSA', wine: 'Ottomani Toscana Bianco', from: 'Malvasía', to: 'Malvasia del Chianti' },
  { producer: 'Ottomani SSA', wine: 'Ottomani Toscana Bianco', from: 'Trebbiano', to: 'Trebbiano Toscano' },
];

// 2. Grape merges. The first three are the schema's synonym design applied
//    (one variety, local display name preserved as "also known as"). Tanageira
//    is an AI garbling of Tinta Pinheira (= Rufete) in Casa de Mouraz's
//    documented Dão field blend.
const GRAPE_MERGES = [
  { from: 'Tinta Roriz', to: 'Tempranillo' },
  { from: 'Nielluccio', to: 'Sangiovese' },
  { from: 'Moscatel de Setúbal', to: 'Muscat of Alexandria' },
  { from: 'Cesanese', to: 'Cesanese Comune' },
  { from: 'Tanageira', to: 'Rufete', synonyms: false },
];

// 3. Spelling fixes — old name kept as synonym when it normalizes differently.
const GRAPE_RENAMES = [
  { from: 'Pais', to: 'País' },
  { from: 'Criollas', to: 'Criolla' },
  { from: 'Lasin', to: 'Lasina' },
];

// 4. Display synonyms on canonical docs ("also known as …" on grape pages;
//    also belt-and-braces against duplicate creation). None of these names
//    exists as its own Grape document.
const GRAPE_SYNONYM_ADDS = {
  'Syrah': ['Shiraz'],
  'Mourvèdre': ['Monastrell', 'Mataro'],
  'Zinfandel': ['Primitivo'],
  'Pinot Gris': ['Pinot Grigio', 'Grauburgunder'],
  'Tempranillo': ['Aragonez'],
  'Rufete': ['Tinta Pinheira'],
};

// 5a. Region renames (canonical form; old name kept as synonym).
const REGION_RENAMES = [
  // Stone Farm Cellars' AVA — drop the ", Pennsylvania" comma style
  { country: 'United States', from: 'Lehigh Valley, Pennsylvania', to: 'Lehigh Valley' },
];

// 5b. Region merges. All verified per wine:
//    Mons Martis = Schneiders-Moritz's Martberg site (Mosel); Walter J. Oster
//    is a Mosel estate; Canaletto rosato is a Veneto IGT brand; Louis de
//    Camponac is Pays d'Oc; Jardinete Branco is Alvarinho/Loureiro/Arinto
//    (Vinho Verde); Vakakis is on Samos; Pasión de Bobal is Utiel-Requena
//    (Valencia); Carl Jung is in Rüdesheim (Rheingau); both
//    "Rhineland-Palatinate" wines are Karl Pfaffmann, appellation Pfalz;
//    "3 Kilos" is Cava from Penedès; "America" = Stone Farm Cellars, Center
//    Valley PA (Lehigh Valley AVA); all "Barossa / Eden Valley" wines are
//    Eden Hall, appellation Eden Valley.
//    synonyms:false everywhere — none of these names belongs on the target.
const REGION_MERGES = [
  { country: 'Germany', from: 'Mosel or Rheingau', to: 'Mosel' },
  { country: 'Germany', from: 'Mosel or Rhine region', to: 'Mosel' },
  { country: 'Germany', from: 'Rheinland-Pfalz', to: 'Rheingau' },
  { country: 'Germany', from: 'Rhineland-Palatinate', to: 'Pfalz' },
  { country: 'Italy', from: 'Emilia-Romagna or Veneto', to: 'Veneto' },
  { country: 'France', from: 'Languedoc or Bordeaux (Vin de France/IGP)', to: 'Languedoc-Roussillon' },
  { country: 'France', from: 'South of France', to: 'Languedoc-Roussillon' },
  { country: 'Portugal', from: 'Vinho Verde or Douro', to: 'Vinho Verde' },
  { country: 'Greece', from: 'Aegean Islands / Samos or Central Greece', to: 'Aegean Islands' },
  { country: 'Spain', from: 'Castilla-La Mancha or Comunitat Valenciana', to: 'Valencia' },
  { country: 'Spain', from: 'Cava DO', to: 'Penedès' },
  { country: 'United States', from: 'America', to: 'Lehigh Valley' },
  { country: 'Australia', from: 'Barossa / Eden Valley', to: 'Eden Valley' },
];

// 6. Single-wine region move — the "France" fallback region keeps its two
//    unresolvable wines (Apparente, St-Rémy brandy); Raisin de Loup is
//    labelled Vin de France.
const WINE_REGION_MOVES = [
  { producer: 'Raisin de Loup', wine: 'Raisin de Loup', country: 'France', toRegion: 'Vin de France' },
];

const stats = { done: 0, skipped: 0, warned: 0 };
const act = (msg) => { stats.done += 1; console.log(`${APPLY ? '✔' : '[dry]'} ${msg}`); };
const skip = (msg) => { stats.skipped += 1; console.log(`  – skip: ${msg}`); };
const warn = (msg) => { stats.warned += 1; console.log(`  ⚠ ${msg}`); };

const findCountry = (name) => Country.findOne({ normalizedName: normalizeString(name) });
const findRegion = (countryId, name) =>
  Region.findOne({ country: countryId, normalizedName: normalizeString(name) });
const findGrape = (name) => Grape.findOne({ normalizedName: normalizeString(name) });

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  // --- 1. Wine grape retags ------------------------------------------------
  console.log('== Wine grape retags ==');
  for (const t of WINE_GRAPE_RETAGS) {
    const [from, to] = await Promise.all([findGrape(t.from), findGrape(t.to)]);
    if (!to) { warn(`target grape "${t.to}" not found`); continue; }
    const wine = await WineDefinition.findOne({ producer: t.producer, name: t.wine });
    if (!wine) { warn(`wine "${t.producer} — ${t.wine}" not found`); continue; }
    if (!from || !wine.grapes.some(g => String(g) === String(from._id))) {
      skip(`"${t.wine}" no longer carries "${t.from}"`);
      continue;
    }
    act(`"${t.producer} — ${t.wine}": grape ${t.from} → ${t.to}`);
    if (APPLY) {
      wine.grapes = wine.grapes.filter(g => String(g) !== String(from._id));
      if (!wine.grapes.some(g => String(g) === String(to._id))) wine.grapes.push(to._id);
      await wine.save();
      searchService.indexWine(wine._id).catch(() => {});
    }
  }

  // --- 2. Grape merges -----------------------------------------------------
  console.log('\n== Grape merges ==');
  for (const m of GRAPE_MERGES) {
    const [from, to] = await Promise.all([findGrape(m.from), findGrape(m.to)]);
    if (!from) { skip(`grape "${m.from}" not found (already merged?)`); continue; }
    if (!to) { warn(`canonical grape "${m.to}" not found — NOT merging "${m.from}"`); continue; }
    const wines = await WineDefinition.countDocuments({ grapes: from._id });
    act(`grape "${m.from}" (${wines} wines) → "${m.to}"${m.synonyms === false ? ' [no synonym]' : ''}`);
    if (APPLY) await mergeGrapes(from._id, to._id, { resync: false, synonyms: m.synonyms !== false });
  }

  // --- 3. Grape renames ----------------------------------------------------
  console.log('\n== Grape renames ==');
  for (const r of GRAPE_RENAMES) {
    const from = await findGrape(r.from);
    if (!from) { skip(`grape "${r.from}" not found (already renamed?)`); continue; }
    if (from.name === r.to) { skip(`grape already named "${r.to}"`); continue; }
    const clash = await findGrape(r.to);
    if (clash && String(clash._id) !== String(from._id)) {
      warn(`cannot rename "${r.from}" — "${r.to}" already exists`);
      continue;
    }
    act(`grape "${r.from}" renamed → "${r.to}"`);
    if (APPLY) {
      if (normalizeString(r.from) !== normalizeString(r.to)) {
        from.synonyms = [...new Set([...(from.synonyms || []), from.name])];
      }
      from.name = r.to;
      from.normalizedName = normalizeString(r.to);
      await from.save();
    }
  }

  // --- 4. Display synonyms -------------------------------------------------
  console.log('\n== Grape synonym additions ==');
  for (const [name, syns] of Object.entries(GRAPE_SYNONYM_ADDS)) {
    const grape = await findGrape(name);
    if (!grape) { warn(`grape "${name}" not found`); continue; }
    const have = new Set((grape.synonyms || []).map(normalizeString));
    const missing = [];
    for (const s of syns) {
      if (have.has(normalizeString(s))) continue;
      // never add a synonym that is itself a Grape document
      const clash = await findGrape(s);
      if (clash) { warn(`"${s}" exists as its own grape — not adding to ${name}`); continue; }
      missing.push(s);
    }
    if (!missing.length) { skip(`${name}: synonyms already present`); continue; }
    act(`${name}: +synonyms ${missing.join(', ')}`);
    if (APPLY) {
      grape.synonyms = [...(grape.synonyms || []), ...missing];
      await grape.save();
    }
  }

  // --- 5a. Region renames --------------------------------------------------
  console.log('\n== Region renames ==');
  for (const r of REGION_RENAMES) {
    const country = await findCountry(r.country);
    if (!country) { warn(`country "${r.country}" not found`); continue; }
    const from = await findRegion(country._id, r.from);
    if (!from) { skip(`region "${r.from}" (${r.country}) not found (already renamed?)`); continue; }
    const existing = await findRegion(country._id, r.to);
    if (existing) {
      act(`region "${r.from}" (${r.country}) merged into existing "${r.to}"`);
      if (APPLY) await mergeRegions(from._id, existing._id, { resync: false });
      continue;
    }
    act(`region "${r.from}" (${r.country}) renamed → "${r.to}"`);
    if (APPLY) {
      from.synonyms = [...new Set([...(from.synonyms || []), from.name])];
      from.name = r.to;
      from.normalizedName = normalizeString(r.to);
      if (from.hierarchy?.length) from.hierarchy[from.hierarchy.length - 1] = r.to;
      await from.save();
    }
  }

  // --- 5b. Region merges ---------------------------------------------------
  console.log('\n== Region merges ==');
  for (const m of REGION_MERGES) {
    const country = await findCountry(m.country);
    if (!country) { warn(`country "${m.country}" not found`); continue; }
    const [from, to] = await Promise.all([
      findRegion(country._id, m.from),
      findRegion(country._id, m.to),
    ]);
    if (!from) { skip(`region "${m.from}" (${m.country}) not found (already merged?)`); continue; }
    if (!to) { warn(`canonical region "${m.to}" (${m.country}) not found — NOT merging "${m.from}"`); continue; }
    const wines = await WineDefinition.countDocuments({ region: from._id });
    act(`region "${m.from}" (${wines} wines) → "${m.to}" [${m.country}] [no synonym]`);
    if (APPLY) await mergeRegions(from._id, to._id, { resync: false, synonyms: false });
  }

  // --- 6. Wine region moves ------------------------------------------------
  console.log('\n== Wine region moves ==');
  for (const mv of WINE_REGION_MOVES) {
    const country = await findCountry(mv.country);
    if (!country) { warn(`country "${mv.country}" not found`); continue; }
    const toRegion = await findRegion(country._id, mv.toRegion);
    if (!toRegion) { warn(`region "${mv.toRegion}" not found`); continue; }
    const wine = await WineDefinition.findOne({ producer: mv.producer, name: mv.wine });
    if (!wine) { warn(`wine "${mv.producer} — ${mv.wine}" not found`); continue; }
    if (String(wine.region) === String(toRegion._id)) { skip(`"${mv.wine}" already in ${mv.toRegion}`); continue; }
    act(`wine "${mv.producer} — ${mv.wine}" → region ${mv.toRegion}`);
    if (APPLY) {
      wine.region = toRegion._id;
      await wine.save();
      searchService.indexWine(wine._id).catch(() => {});
    }
  }

  console.log(`\nSummary: ${stats.done} actions, ${stats.skipped} skipped, ${stats.warned} warnings.`);
  if (APPLY) {
    console.log('Rebuilding wines search index…');
    await searchService.initialize();
    await searchService.fullSync();
    console.log('Done. NOTE: run a bottles resync separately (fullSyncBottles needs all models registered).');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Manual cleanup failed:', err);
  process.exit(1);
});
