/**
 * cleanup-taxonomy-2026-07.js
 *
 * One-shot remediation for the taxonomy audit of 2026-07-18
 * (TAXONOMY_AUDIT_2026-07-18.md): merges duplicate/wrong grape and region
 * documents into their canonical counterparts, renames a few regions to their
 * canonical form, fixes the sake wine filed under country "Unknown", and
 * deletes zero-usage countries (label scan recreates any of them on demand).
 *
 * Only HIGH-CONFIDENCE items from the audit are encoded here. Judgment calls
 * (Tinta Roriz→Tempranillo display question, generic Muscat/Malvasía/
 * Trebbiano docs, the seven "X or Y" AI-junk regions, spirits-in-registry)
 * are intentionally left for a manual admin pass.
 *
 * Every merge goes through services/taxonomyMerge, so all references are
 * rewritten before deletion and old names become synonyms on the canonical
 * doc (except junk names, which are dropped).
 *
 * Usage:
 *   node src/scripts/cleanup-taxonomy-2026-07.js           # dry run
 *   node src/scripts/cleanup-taxonomy-2026-07.js --apply   # execute
 *
 * Idempotent: already-merged/renamed/deleted entries are skipped with a note.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const WineDefinition = require('../models/WineDefinition');
const { mergeGrapes, mergeRegions } = require('../services/taxonomyMerge');
const searchService = require('../services/search');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// Grape merges: { from, to, synonyms:false } — synonyms:false for junk names
// (percent artifacts, typos, ambiguous labels) that must not become synonyms.
// ---------------------------------------------------------------------------
const GRAPE_MERGES = [
  // Blend-percentage artifacts (all from one wine) + typo
  { from: '70% Monastrell', to: 'Mourvèdre', synonyms: false },
  { from: '25% Cabernet Sauvignon', to: 'Cabernet Sauvignon', synonyms: false },
  { from: '5% Merlot', to: 'Merlot', synonyms: false },
  { from: 'Mouvedre', to: 'Mourvèdre', synonyms: false },

  // Wrong-in-context (verified against the referencing wines; the raw name is
  // ambiguous as a future synonym, so it is not absorbed)
  { from: 'Moscatel', to: 'Muscat of Alexandria', synonyms: false },  // Canary "Moscatel"
  { from: 'Bonarda', to: 'Croatina', synonyms: false },               // Colli Piacentini Bonarda
  { from: 'Picpoul', to: 'Picpoul Noir', synonyms: false },           // both wines are red CdP

  // Same variety, different name — old name becomes a synonym
  { from: 'Pinot Nero', to: 'Pinot Noir' },
  { from: 'Meunier', to: 'Pinot Meunier' },
  { from: 'Schwarzriesling', to: 'Pinot Meunier' },
  { from: 'Weißburgunder', to: 'Pinot Blanc' },
  { from: 'Weisser Burgunder', to: 'Pinot Blanc' },
  { from: 'Cariñena', to: 'Carignan' },
  { from: 'Carignano', to: 'Carignan' },
  { from: 'Macabeu', to: 'Macabeo' },
  { from: 'Viura', to: 'Macabeo' },
  { from: 'Durif', to: 'Petite Sirah' },
  { from: 'Lemberger', to: 'Blaufränkisch' },
  { from: 'Riesling-Silvaner', to: 'Müller-Thurgau' },
  { from: 'Riesling x Sylvaner', to: 'Müller-Thurgau' },
  { from: 'Rolle', to: 'Vermentino' },
  { from: 'Zibibbo', to: 'Muscat of Alexandria' },
  { from: 'Moscato Bianco', to: 'Muscat Blanc à Petits Grains' },
  { from: 'Muscat à Petits Grains', to: 'Muscat Blanc à Petits Grains' },
  { from: 'Muscat de Frontignan', to: 'Muscat Blanc à Petits Grains' },
  { from: 'Sárgamuskotály', to: 'Muscat Blanc à Petits Grains' },
  { from: 'Muskateller', to: 'Muscat Blanc à Petits Grains' },
  { from: 'Tocai Friulano', to: 'Friulano' },
  { from: 'Cannonau', to: 'Grenache' },
  { from: 'Garnacho', to: 'Grenache' },
  { from: 'Pansa Blanca', to: 'Xarel-lo' },
  { from: 'Prosecco', to: 'Glera' },
  { from: 'Maria Gomes', to: 'Fernão Pires' },
  { from: 'Bastardo', to: 'Trousseau' },
  { from: 'Jaen', to: 'Mencía' },
  { from: 'Listán Blanco', to: 'Palomino' },
  { from: 'Gouveio', to: 'Godello' },
  { from: 'Gutedel', to: 'Chasselas' },
  { from: 'Trebbiano di Lugana', to: 'Turbiana' },
  { from: 'Frontenac Noir', to: 'Frontenac' },
];

// ---------------------------------------------------------------------------
// Region renames (canonical target does not exist yet). The old name becomes
// a synonym; if the target name already exists in the country, the entry is
// merged into it instead (idempotent re-runs).
// ---------------------------------------------------------------------------
const REGION_RENAMES = [
  { country: 'Portugal', from: 'Ribatejo', to: 'Tejo' },
  { country: 'France', from: 'France (Vin de France)', to: 'Vin de France' },
  { country: 'Australia', from: 'Eden Valley, South Australia', to: 'Eden Valley' },
  { country: 'Argentina', from: 'Mendoza - Uco Valley', to: 'Uco Valley' },
  { country: 'Argentina', from: 'Cafayate, Salta', to: 'Cafayate' },
];

// ---------------------------------------------------------------------------
// Region merges (same country, both docs exist).
// ---------------------------------------------------------------------------
const REGION_MERGES = [
  // Italy
  { country: 'Italy', from: 'Piemonte', to: 'Piedmont' },
  { country: 'Italy', from: 'Sicile', to: 'Sicily' },
  { country: 'Italy', from: 'South Tyrol / Alto Adige', to: 'Alto Adige (Südtirol)' },
  { country: 'Italy', from: 'Trentino-Alto Adige / Dolomiti', to: 'Trentino-Alto Adige' },
  { country: 'Italy', from: 'Veneto / Tre Venezie', to: 'Veneto' },
  { country: 'Italy', from: 'Tre Venezie (Northeastern Italy)', to: 'Veneto' },
  { country: 'Italy', from: 'Lombardia', to: 'Lombardy' },
  { country: 'Italy', from: 'Lombardy / Veneto (Lake Garda)', to: 'Lombardy' },
  // Germany
  { country: 'Germany', from: 'Palatinate (Pfalz)', to: 'Pfalz' },
  { country: 'Germany', from: 'Rhinehessen', to: 'Rheinhessen' },
  { country: 'Germany', from: 'Franconia', to: 'Franken' },
  // France
  { country: 'France', from: 'Burgundy (Bourgogne)', to: 'Burgundy' },
  { country: 'France', from: 'Burgundy / Côte de Beaune', to: 'Burgundy' },
  { country: 'France', from: 'Burgundy / Côte de Nuits', to: 'Burgundy' },
  { country: 'France', from: 'Burgundy / Mâconnais', to: 'Burgundy' },
  { country: 'France', from: 'Burgundy, Côte de Nuits, Gevrey-Chambertin', to: 'Burgundy' },
  { country: 'France', from: 'Rhône', to: 'Rhône Valley' },
  { country: 'France', from: 'Northern Rhône Valley', to: 'Northern Rhône' },
  { country: 'France', from: 'Southern Rhône Valley', to: 'Southern Rhône' },
  { country: 'France', from: 'Sud de France', to: 'Languedoc-Roussillon' },
  { country: 'France', from: 'South West France (Gascony)', to: 'Southwest France' },
  { country: 'France', from: 'Gascony (Gascogne)', to: 'Southwest France' },
  { country: 'France', from: 'Sud-Ouest', to: 'Southwest France' },
  { country: 'France', from: 'Southwest France / Cahors', to: 'Southwest France' },
  { country: 'France', from: 'South West France', to: 'Southwest France' },
  // United States
  { country: 'United States', from: 'Napa Valley, California', to: 'Napa Valley' },
  { country: 'United States', from: 'Napa Valley, Carneros', to: 'Napa Valley' },
  { country: 'United States', from: 'Central Coast, California', to: 'Central Coast' },
  { country: 'United States', from: 'Sonoma County, California', to: 'Sonoma County' },
  { country: 'United States', from: 'Finger Lakes, New York', to: 'Finger Lakes' },
  { country: 'United States', from: 'PA', to: 'Pennsylvania' },
  { country: 'United States', from: 'Washington State', to: 'Washington' },
  { country: 'United States', from: 'Monterey, California', to: 'Monterey County' },
  { country: 'United States', from: 'Santa Barbara County, California', to: 'Santa Barbara County' },
  // Australia
  { country: 'Australia', from: 'Barossa Valley, South Australia', to: 'Barossa Valley' },
  { country: 'Australia', from: 'Barossa Zone', to: 'Barossa Valley' },
  { country: 'Australia', from: 'Clare Valley, South Australia', to: 'Clare Valley' },
  { country: 'Australia', from: 'McLaren Vale, South Australia', to: 'McLaren Vale' },
  { country: 'Australia', from: 'Margaret River, Western Australia', to: 'Margaret River' },
  { country: 'Australia', from: 'Langhorne Creek, South Australia', to: 'Langhorne Creek' },
  // Canada
  { country: 'Canada', from: 'Niagara Peninsula, Ontario', to: 'Niagara Peninsula' },
  { country: 'Canada', from: 'Niagara-on-the-Lake', to: 'Niagara Peninsula' },
  { country: 'Canada', from: 'Niagara-on-the-Lake, Ontario', to: 'Niagara Peninsula' },
  // Chile
  { country: 'Chile', from: 'Valle Central', to: 'Central Valley' },
  { country: 'Chile', from: 'Valle del Rapel', to: 'Rapel Valley' },
  // Argentina (after the Uco Valley rename above)
  { country: 'Argentina', from: 'Valle de Uco, Mendoza', to: 'Uco Valley' },
  // Austria
  { country: 'Austria', from: 'Niederösterreich (Lower Austria)', to: 'Niederösterreich' },
  // Portugal (after the Tejo rename above)
  { country: 'Portugal', from: 'Douro Valley', to: 'Douro' },
  { country: 'Portugal', from: 'Açores', to: 'Azores' },
  { country: 'Portugal', from: 'Setúbal', to: 'Setúbal Peninsula' },
  { country: 'Portugal', from: 'Península de Setúbal', to: 'Setúbal Peninsula' },
  { country: 'Portugal', from: 'Ribatejo / Tejo', to: 'Tejo' },
  { country: 'Portugal', from: 'Minho / Vinho Verde', to: 'Vinho Verde' },
  // Spain
  { country: 'Spain', from: 'La Rioja', to: 'Rioja' },
  { country: 'Spain', from: 'Jumilla DOP', to: 'Jumilla' },
  { country: 'Spain', from: 'Castilla y León / Bierzo', to: 'Castilla y León' },
  { country: 'Spain', from: 'Murcia / Levante', to: 'Murcia' },
  { country: 'Spain', from: 'Vino de la Tierra de Castilla', to: 'Castilla IGP' },
  // Greece
  { country: 'Greece', from: 'Achaia, Peloponnese', to: 'Peloponnese' },
  // New Zealand — Central Otago is the only major Otago wine region; the
  // separate "North Otago" (Waitaki) doc is untouched.
  { country: 'New Zealand', from: 'Otago', to: 'Central Otago' },
];

// Zero-usage regions deleted only to unblock a country deletion below.
const REGION_DELETES = [{ country: 'Albania', name: 'Korçë' }];

// Countries with zero wines and zero regions — recreated on demand by
// findOrCreateCountry/resolveCountryName if a wine ever needs them.
const COUNTRY_DELETES = [
  'Azerbaijan', 'China', 'Cyprus', 'Denmark', 'Finland', 'Golan Heights',
  'Moldova', 'Montenegro', 'Peru', 'Romania', 'Slovenia', 'Syria',
  'Hong Kong', 'Thailand', 'Malta', 'Tunisia', 'India', 'Russian Federation',
  'Indonesia', 'Bosnia and Herzegovina', 'Ecuador', 'Albania', 'Bhutan',
];

// Wines filed under country "Unknown" that have an identifiable home.
const WINE_COUNTRY_FIXES = [
  // Daimon Brewery — sake, Osaka. Region intentionally left empty.
  { producer: 'Daimon', wineName: 'Daimon', toCountry: 'Japan' },
];

const stats = { done: 0, skipped: 0, warned: 0 };
const log = (msg) => console.log(msg);
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
  log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  // --- 1. Wine country fixes -----------------------------------------------
  log('== Wine country fixes ==');
  for (const fix of WINE_COUNTRY_FIXES) {
    const to = await findCountry(fix.toCountry);
    if (!to) { warn(`target country "${fix.toCountry}" not found`); continue; }
    const wine = await WineDefinition.findOne({ producer: fix.producer, name: fix.wineName });
    if (!wine) { skip(`wine "${fix.producer} — ${fix.wineName}" not found`); continue; }
    if (String(wine.country) === String(to._id)) { skip(`"${fix.wineName}" already in ${fix.toCountry}`); continue; }
    act(`wine "${fix.producer} — ${fix.wineName}" → country ${fix.toCountry}`);
    if (APPLY) {
      wine.country = to._id;
      wine.region = null;
      await wine.save();
      searchService.indexWine(wine._id).catch(() => {});
    }
  }

  // --- 2. Grape merges -----------------------------------------------------
  log('\n== Grape merges ==');
  for (const m of GRAPE_MERGES) {
    const [from, to] = await Promise.all([findGrape(m.from), findGrape(m.to)]);
    if (!from) { skip(`grape "${m.from}" not found (already merged?)`); continue; }
    if (!to) { warn(`canonical grape "${m.to}" not found — NOT merging "${m.from}"`); continue; }
    const wines = await WineDefinition.countDocuments({ grapes: from._id });
    act(`grape "${m.from}" (${wines} wines) → "${m.to}"${m.synonyms === false ? ' [no synonym]' : ''}`);
    if (APPLY) {
      await mergeGrapes(from._id, to._id, { resync: false, synonyms: m.synonyms !== false });
    }
  }

  // --- 3. Region renames ---------------------------------------------------
  log('\n== Region renames ==');
  for (const r of REGION_RENAMES) {
    const country = await findCountry(r.country);
    if (!country) { warn(`country "${r.country}" not found`); continue; }
    const from = await findRegion(country._id, r.from);
    if (!from) { skip(`region "${r.from}" (${r.country}) not found (already renamed?)`); continue; }
    const existingTarget = await findRegion(country._id, r.to);
    if (existingTarget) {
      // Target name already exists — fold instead of renaming into a collision.
      act(`region "${r.from}" (${r.country}) merged into existing "${r.to}"`);
      if (APPLY) await mergeRegions(from._id, existingTarget._id, { resync: false });
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

  // --- 4. Region merges ----------------------------------------------------
  log('\n== Region merges ==');
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
    act(`region "${m.from}" (${wines} wines) → "${m.to}" [${m.country}]`);
    if (APPLY) {
      await mergeRegions(from._id, to._id, { resync: false });
    }
  }

  // --- 5. Zero-usage region deletions --------------------------------------
  log('\n== Region deletions ==');
  for (const d of REGION_DELETES) {
    const country = await findCountry(d.country);
    if (!country) { skip(`country "${d.country}" not found`); continue; }
    const region = await findRegion(country._id, d.name);
    if (!region) { skip(`region "${d.name}" (${d.country}) not found`); continue; }
    const [wines, children, apps] = await Promise.all([
      WineDefinition.countDocuments({ region: region._id }),
      Region.countDocuments({ parentRegion: region._id }),
      Appellation.countDocuments({ region: region._id }),
    ]);
    if (wines || children || apps) {
      warn(`region "${d.name}" is referenced (${wines} wines, ${children} children, ${apps} appellations) — NOT deleting`);
      continue;
    }
    act(`delete region "${d.name}" (${d.country})`);
    if (APPLY) await region.deleteOne();
  }

  // --- 6. Zero-usage country deletions -------------------------------------
  log('\n== Country deletions ==');
  for (const name of COUNTRY_DELETES) {
    const country = await findCountry(name);
    if (!country) { skip(`country "${name}" not found (already deleted?)`); continue; }
    const [wines, regions, apps] = await Promise.all([
      WineDefinition.countDocuments({ country: country._id }),
      Region.countDocuments({ country: country._id }),
      Appellation.countDocuments({ country: country._id }),
    ]);
    if (wines || regions || apps) {
      warn(`country "${name}" is referenced (${wines} wines, ${regions} regions, ${apps} appellations) — NOT deleting`);
      continue;
    }
    act(`delete country "${name}"`);
    if (APPLY) await country.deleteOne();
  }

  // --- 7. Search resync ----------------------------------------------------
  log(`\nSummary: ${stats.done} actions, ${stats.skipped} skipped, ${stats.warned} warnings.`);
  if (APPLY) {
    log('Rebuilding search indexes (wines + bottles denormalize taxonomy names)…');
    await searchService.initialize();
    await searchService.fullSync();
    await searchService.fullSyncBottles();
    log('Search resync done.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
