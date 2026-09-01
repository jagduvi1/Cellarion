/**
 * Seed display-name translations for countries and regions.
 *
 * Dry-run by default; pass --apply to write. Idempotent — re-running changes
 * nothing once the values are in.
 *
 *   docker compose -p prod exec -T backend node src/scripts/seed-taxonomy-translations.js
 *   docker compose -p prod exec -T backend node src/scripts/seed-taxonomy-translations.js --apply
 *
 * WHERE THESE VALUES COME FROM. The country names are the display forms of
 * aliases utils/normalize already carries and annotates by language — we have
 * been ACCEPTING "Allemagne", "Frankrike" and "Österreich" on import for
 * months and storing the English. This only gives them back. The region names
 * are the standard exonyms for the same places.
 *
 * WHAT IS DELIBERATELY ABSENT: every entry whose name does not change with the
 * language. Champagne, Alsace, Rioja, Douro, Mosel, Nahe, Barossa Valley,
 * Coonawarra and most of the New World read identically in all four, and a
 * translation equal to the canonical name is dead weight the endpoint would
 * filter out anyway. Appellations and grapes are not here at all — see
 * utils/localizedName for why.
 *
 * These are authored, not community-reviewed. They are ordinary DB rows, not
 * Weblate strings, so a native speaker can correct any of them through
 * PUT /api/admin/taxonomy/:kind/:id/translations without a release.
 */

const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const { sanitizeTranslations } = require('../utils/localizedName');

// canonical English name -> { fr, de, sv }
const COUNTRIES = {
  France: { de: 'Frankreich', sv: 'Frankrike' },
  Italy: { fr: 'Italie', de: 'Italien', sv: 'Italien' },
  Spain: { fr: 'Espagne', de: 'Spanien', sv: 'Spanien' },
  Germany: { fr: 'Allemagne', de: 'Deutschland', sv: 'Tyskland' },
  Austria: { fr: 'Autriche', de: 'Österreich', sv: 'Österrike' },
  Switzerland: { fr: 'Suisse', de: 'Schweiz', sv: 'Schweiz' },
  'United States': { fr: 'États-Unis', de: 'Vereinigte Staaten', sv: 'USA' },
  Australia: { fr: 'Australie', de: 'Australien', sv: 'Australien' },
  'New Zealand': { fr: 'Nouvelle-Zélande', de: 'Neuseeland', sv: 'Nya Zeeland' },
  'South Africa': { fr: 'Afrique du Sud', de: 'Südafrika', sv: 'Sydafrika' },
  Greece: { fr: 'Grèce', de: 'Griechenland', sv: 'Grekland' },
  Hungary: { fr: 'Hongrie', de: 'Ungarn', sv: 'Ungern' },
  England: { fr: 'Angleterre' },
  Argentina: { fr: 'Argentine', de: 'Argentinien' },
  Chile: { fr: 'Chili' },
  Lebanon: { fr: 'Liban', de: 'Libanon', sv: 'Libanon' },
  Israel: { fr: 'Israël' },
  Croatia: { fr: 'Croatie', de: 'Kroatien', sv: 'Kroatien' },
  Romania: { fr: 'Roumanie', de: 'Rumänien', sv: 'Rumänien' },
  Slovenia: { fr: 'Slovénie', de: 'Slowenien', sv: 'Slovenien' },
  Georgia: { fr: 'Géorgie', de: 'Georgien', sv: 'Georgien' },
  Turkey: { fr: 'Turquie', de: 'Türkei', sv: 'Turkiet' },
  Morocco: { fr: 'Maroc', de: 'Marokko', sv: 'Marocko' },
  Canada: { de: 'Kanada', sv: 'Kanada' },
  Mexico: { fr: 'Mexique', de: 'Mexiko', sv: 'Mexiko' },
  Brazil: { fr: 'Brésil', de: 'Brasilien', sv: 'Brasilien' },
  Uruguay: {},
};

// Region names only where the exonym genuinely differs.
const REGIONS = {
  Burgundy: { fr: 'Bourgogne', de: 'Burgund', sv: 'Bourgogne' },
  Tuscany: { fr: 'Toscane', de: 'Toskana', sv: 'Toscana' },
  'Rhône Valley': { fr: 'Vallée du Rhône', de: 'Rhônetal', sv: 'Rhônedalen' },
  Piedmont: { fr: 'Piémont', de: 'Piemont', sv: 'Piemonte' },
  'Loire Valley': { fr: 'Vallée de la Loire', de: 'Loiretal', sv: 'Loiredalen' },
  California: { fr: 'Californie', de: 'Kalifornien', sv: 'Kalifornien' },
  Veneto: { fr: 'Vénétie', de: 'Venetien' },
  Sicily: { fr: 'Sicile', de: 'Sizilien', sv: 'Sicilien' },
  Puglia: { fr: 'Pouilles', de: 'Apulien', sv: 'Apulien' },
  Lombardy: { fr: 'Lombardie', de: 'Lombardei', sv: 'Lombardiet' },
  Campania: { fr: 'Campanie', de: 'Kampanien' },
  'Southwest France': { fr: 'Sud-Ouest', de: 'Südwestfrankreich', sv: 'Sydvästra Frankrike' },
  'South Australia': { fr: 'Australie-Méridionale', de: 'Südaustralien', sv: 'Södra Australien' },
  Sardinia: { fr: 'Sardaigne', de: 'Sardinien', sv: 'Sardinien' },
  Umbria: { fr: 'Ombrie', de: 'Umbrien' },
  Catalonia: { fr: 'Catalogne', de: 'Katalonien', sv: 'Katalonien' },
  'Basque Country': { fr: 'Pays basque', de: 'Baskenland', sv: 'Baskien' },
  Andalusia: { fr: 'Andalousie', de: 'Andalusien', sv: 'Andalusien' },
  'Northern Rhône': { fr: 'Rhône septentrional', de: 'Nördliche Rhône' },
  'Southern Rhône': { fr: 'Rhône méridional', de: 'Südliche Rhône' },
};

async function seed(Model, table, label, apply) {
  let changed = 0;
  let already = 0;
  let missing = 0;

  for (const [name, raw] of Object.entries(table)) {
    const parsed = sanitizeTranslations(raw);
    if (!parsed.ok) throw new Error(`${label} "${name}": ${parsed.error}`);
    const wanted = parsed.translations;
    if (Object.keys(wanted).length === 0) continue;   // nothing to say in any language

    const doc = await Model.findOne({ name });
    if (!doc) { missing++; console.log(`  – ${label} "${name}" is not in the taxonomy, skipped`); continue; }

    const current = doc.translations ? Object.fromEntries(doc.translations) : {};
    // Merge, never clobber: a curator may have corrected one of these by hand,
    // and a seed script re-running must not quietly undo that.
    const merged = { ...wanted, ...current };
    if (JSON.stringify(merged) === JSON.stringify(current)) { already++; continue; }

    const added = Object.keys(merged).filter((k) => current[k] === undefined);
    console.log(`  ${apply ? '✓' : '·'} ${label} "${name}": +${added.map((k) => `${k}=${merged[k]}`).join(', ')}`);
    if (apply) { doc.translations = merged; await doc.save(); }
    changed++;
  }
  return { changed, already, missing };
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(apply ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===');

  const c = await seed(Country, COUNTRIES, 'country', apply);
  const r = await seed(Region, REGIONS, 'region', apply);

  console.log(`\ncountries: ${c.changed} to change, ${c.already} already current, ${c.missing} not in taxonomy`);
  console.log(`regions:   ${r.changed} to change, ${r.already} already current, ${r.missing} not in taxonomy`);
  if (!apply) console.log('\nNothing was written.');

  await mongoose.disconnect();
  process.exit(0);
}

// Only when RUN. Requiring this file (its tables are worth asserting on) must
// not open a database connection as a side effect.
if (require.main === module) {
  main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
}

module.exports = { COUNTRIES, REGIONS };
