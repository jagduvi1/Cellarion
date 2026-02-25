/**
 * Bulk data import script: populates the database with comprehensive taxonomy and wine data.
 *
 * Prerequisites: Run seed.js first (creates admin user needed as createdBy).
 * Run via: docker exec wine-cellar-backend node src/seed-data.js
 *
 * Data sources (in backend/src/data/):
 *   - grapes_master_expanded.json        (49 grapes with metadata)
 *   - *_wine_regions.json / *Regions.json (16 countries with regions & appellations)
 *   - wine_cellar_wines_no_multipack_box.json (9,560 wines from Systembolaget)
 */

'use strict';

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { generateWineKey, normalizeString } = require('./utils/normalize');

const User = require('./models/User');
const Country = require('./models/Country');
const Region = require('./models/Region');
const Grape = require('./models/Grape');
const WineDefinition = require('./models/WineDefinition');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';
const DATA_DIR = path.join(__dirname, 'data');

// ─── Swedish → English country name mapping ──────────────────────────────────
const COUNTRY_NAME_MAP = {
  'Armenien': 'Armenia',
  'Azerbajdzjan': 'Azerbaijan',
  'Belgien': 'Belgium',
  'Brasilien': 'Brazil',
  'Bulgarien': 'Bulgaria',
  'Cypern': 'Cyprus',
  'Danmark': 'Denmark',
  'Finland': 'Finland',
  'Folkrepubliken Kina': 'China',
  'Golanhöjderna (israelisk bosättning)': 'Golan Heights',
  'Internationellt märke': null, // skip — not a country
  'Japan': 'Japan',
  'Kanada': 'Canada',
  'Kroatien': 'Croatia',
  'Libanon': 'Lebanon',
  'Luxemburg': 'Luxembourg',
  'Mexiko': 'Mexico',
  'Moldavien': 'Moldova',
  'Montenegro': 'Montenegro',
  'Nordmakedonien': 'North Macedonia',
  'Norge': 'Norway',
  'Peru': 'Peru',
  'Polen': 'Poland',
  'Rumänien': 'Romania',
  'Serbien': 'Serbia',
  'Slovakien': 'Slovakia',
  'Slovenien': 'Slovenia',
  'Storbritannien': 'United Kingdom',
  'Sverige': 'Sweden',
  'Tjeckien': 'Czech Republic',
  'Ukraina': 'Ukraine',
  'Uruguay': 'Uruguay',
  'EU': null, // skip — not a country
  'Israel': 'Israel',
  // Already English — included for completeness
  'France': 'France',
  'Italy': 'Italy',
  'Spain': 'Spain',
  'Germany': 'Germany',
  'Austria': 'Austria',
  'Portugal': 'Portugal',
  'Greece': 'Greece',
  'Hungary': 'Hungary',
  'Georgia': 'Georgia',
  'Argentina': 'Argentina',
  'Chile': 'Chile',
  'Australia': 'Australia',
  'New Zealand': 'New Zealand',
  'South Africa': 'South Africa',
  'United States': 'United States',
  'Switzerland': 'Switzerland',
};

// ─── ISO country codes ───────────────────────────────────────────────────────
const COUNTRY_CODES = {
  'France': 'FR', 'Italy': 'IT', 'Spain': 'ES', 'Germany': 'DE',
  'Austria': 'AT', 'Portugal': 'PT', 'Greece': 'GR', 'Hungary': 'HU',
  'Georgia': 'GE', 'Argentina': 'AR', 'Chile': 'CL', 'Australia': 'AU',
  'New Zealand': 'NZ', 'South Africa': 'ZA', 'United States': 'US',
  'Switzerland': 'CH', 'Armenia': 'AM', 'Azerbaijan': 'AZ', 'Belgium': 'BE',
  'Brazil': 'BR', 'Bulgaria': 'BG', 'Cyprus': 'CY', 'Denmark': 'DK',
  'Finland': 'FI', 'China': 'CN', 'Golan Heights': null, 'Japan': 'JP',
  'Canada': 'CA', 'Croatia': 'HR', 'Lebanon': 'LB', 'Luxembourg': 'LU',
  'Mexico': 'MX', 'Moldova': 'MD', 'Montenegro': 'ME',
  'North Macedonia': 'MK', 'Norway': 'NO', 'Peru': 'PE', 'Poland': 'PL',
  'Romania': 'RO', 'Serbia': 'RS', 'Slovakia': 'SK', 'Slovenia': 'SI',
  'United Kingdom': 'GB', 'Sweden': 'SE', 'Czech Republic': 'CZ',
  'Ukraine': 'UA', 'Uruguay': 'UY', 'Israel': 'IL',
};

// ─── Swedish → English region (origin.level1) mapping ────────────────────────
const REGION_NAME_MAP = {
  'Abruzzerna': 'Abruzzo',
  'Andalusien': 'Andalusia',
  'Apulien': 'Puglia',
  'Aragonien': 'Aragon',
  'Azorerna': 'Azores',
  'Balearerna': 'Balearic Islands',
  'Basilicata': 'Basilicata',
  'Baskien': 'Basque Country',
  'Bourgogne': 'Burgundy',
  'Emilia-Romagna': 'Emilia-Romagna',
  'Extremadura': 'Extremadura',
  'Frankrike sydväst': 'Southwest France',
  'Friuli-Venezia-Giulia': 'Friuli Venezia Giulia',
  'Galicien': 'Galicia',
  'Kalifornien': 'California',
  'Kampanien': 'Campania',
  'Kanarieöarna': 'Canary Islands',
  'Kastilien-La Mancha': 'Castilla-La Mancha',
  'Kastilien-León': 'Castilla y León',
  'Katalonien': 'Catalonia',
  'Korsika': 'Corsica',
  'Kreta': 'Crete',
  'Kykladerna': 'Cyclades',
  'Latium': 'Lazio',
  'Ligurien': 'Liguria',
  'Loiredalen': 'Loire Valley',
  'Lombardiet': 'Lombardy',
  'Makedonien': 'Macedonia',
  'Méditerranée': 'Mediterranean',
  'Murcia': 'Murcia',
  'Navarra': 'Navarra',
  'Patagonien': 'Patagonia',
  'Peloponnesos': 'Peloponnese',
  'Piemonte': 'Piedmont',
  'Rhonedalen': 'Rhône Valley',
  'Sardinien': 'Sardinia',
  'Sicilien': 'Sicily',
  'Tasmanien': 'Tasmania',
  'Toscana': 'Tuscany',
  'Trakiska låglandet': 'Thracian Lowland',
  'Strumadalen': 'Struma Valley',
  'Umbrien': 'Umbria',
  'Valencia': 'Valencia',
  'Venetien': 'Veneto',
  'Felsö-magyarországi': 'Upper Hungary',
  'Muntenia': 'Muntenia',
  'Oltenia': 'Oltenia',
  // Swedish counties (län) — translate to county names
  'Blekinge län': 'Blekinge',
  'Gotlands län': 'Gotland',
  'Gävleborgs län': 'Gävleborg',
  'Hallands län': 'Halland',
  'Kalmar län': 'Kalmar',
  'Kronobergs län': 'Kronoberg',
  'Norrbottens län': 'Norrbotten',
  'Skåne län': 'Skåne',
  'Stockholms län': 'Stockholm',
  'Södermanlands län': 'Södermanland',
  'Värmlands län': 'Värmland',
  'Västerbottens län': 'Västerbotten',
  'Västra Götalands län': 'Västra Götaland',
  'Örebro län': 'Örebro',
  // German/Austrian
  'Niederösterreich': 'Lower Austria',
  'Weinland Österreich': 'Weinland',
  'Südsteiermark': 'South Styria',
  'Graubünden': 'Graubünden',
  // Already OK or minor
  'Trentino-Alto Adige': 'Trentino-Alto Adige',
  "Valle d'Aosta": "Valle d'Aosta",
  'Podravina': 'Podravina',
  'Primorska': 'Primorska',
  'Primorski': 'Primorski',
  'Kontinentalna': 'Continental Croatia',
};

// ─── Category level2 → wine type mapping ─────────────────────────────────────
const CATEGORY_MAP = {
  'Red Wine': 'red',
  'White Wine': 'white',
  'Rosé Wine': 'rosé',
  'Sparkling Wine': 'sparkling',
  'Starkvin': 'fortified',       // Port, Sherry, Madeira, etc.
};

// Categories to skip (not wine)
const SKIP_CATEGORIES = new Set([
  'Aperitifer', 'Drycker av flera typer', 'Glögg och Glühwein',
  'Sake', 'Smaksatt vin & fruktvin', 'Vermouth',
]);

// ─── Region file → country mapping ──────────────────────────────────────────
const REGION_FILES = [
  { file: 'FranceRegions.json', format: 'appellations' },
  { file: 'ItalyRegions.json', format: 'appellations' },
  { file: 'spain_wine_regions.json', format: 'appellations' },
  { file: 'germany_wine_regions.json', format: 'appellations' },
  { file: 'portugal_wine_regions.json', format: 'appellations' },
  { file: 'austria_wine_regions.json', format: 'appellations' },
  { file: 'greece_wine_regions.json', format: 'simple' },
  { file: 'hungary_wine_regions.json', format: 'simple' },
  { file: 'georgia_wine_regions.json', format: 'simple' },
  { file: 'argentina_wine_regions.json', format: 'simple' },
  { file: 'chile_wine_regions.json', format: 'simple' },
  { file: 'australia_wine_regions.json', format: 'simple' },
  { file: 'new_zealand_wine_regions.json', format: 'simple' },
  { file: 'south_africa_wine_regions.json', format: 'simple' },
  { file: 'usa_wine_regions.json', format: 'simple' },
  { file: 'switzerland_wine_regions.json', format: 'simple' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function translateCountry(name) {
  if (!name) return null;
  if (COUNTRY_NAME_MAP[name] !== undefined) return COUNTRY_NAME_MAP[name];
  return name; // keep as-is if no mapping
}

function translateRegion(name) {
  if (!name) return null;
  if (REGION_NAME_MAP[name]) return REGION_NAME_MAP[name];
  return name;
}

function mapCategoryToType(category) {
  if (!category || !category.level2) return null;
  if (SKIP_CATEGORIES.has(category.level2)) return null;
  return CATEGORY_MAP[category.level2] || null;
}

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

// ─── Main seed function ──────────────────────────────────────────────────────

async function seedData() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  // We need the admin user as createdBy — must run seed.js first
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    console.error('ERROR: No admin user found. Run seed.js first.');
    process.exit(1);
  }
  console.log(`Using admin: ${admin.email}\n`);

  // ─── 1. GRAPES ────────────────────────────────────────────────────────────
  console.log('=== GRAPES ===');
  const grapesData = loadJSON('grapes_master_expanded.json');
  const grapeCache = {}; // normalizedName → doc

  // Load existing grapes into cache
  const existingGrapes = await Grape.find({});
  for (const g of existingGrapes) {
    grapeCache[g.normalizedName] = g;
  }

  let grapesCreated = 0;
  let grapesUpdated = 0;
  for (const g of grapesData.grapes) {
    const normalized = normalizeString(g.name);
    const metadata = {
      color: g.color || null,
      origin: g.origin || null,
      characteristics: g.characteristics || [],
      agingPotential: g.agingPotential || null,
      prestige: g.prestige || null,
    };

    if (grapeCache[normalized]) {
      // Update existing grape with metadata if missing
      const existing = grapeCache[normalized];
      if (!existing.color && metadata.color) {
        await Grape.updateOne({ _id: existing._id }, { $set: metadata });
        grapesUpdated++;
      }
      continue;
    }

    const doc = await Grape.create({
      name: g.name,
      normalizedName: normalized,
      synonyms: [],
      ...metadata,
      createdBy: admin._id,
    });
    grapeCache[normalized] = doc;
    grapesCreated++;
  }
  console.log(`  Master grapes: ${grapesCreated} created, ${grapesUpdated} updated with metadata, ${grapesData.grapes.length - grapesCreated - grapesUpdated} unchanged`);

  // ─── 2. COUNTRIES ─────────────────────────────────────────────────────────
  console.log('\n=== COUNTRIES ===');
  const countryCache = {}; // normalizedName → doc

  // Load existing countries into cache
  const existingCountries = await Country.find({});
  for (const c of existingCountries) {
    countryCache[c.normalizedName] = c;
  }

  // Collect all unique country names from region files + wine data
  const allCountryNames = new Set();

  // From region files
  for (const rf of REGION_FILES) {
    const data = loadJSON(rf.file);
    const name = translateCountry(data.country);
    if (name) allCountryNames.add(name);
  }

  // From wine data (translate Swedish → English)
  const winesRaw = loadJSON('wine_cellar_wines_no_multipack_box.json');
  for (const w of winesRaw) {
    const name = translateCountry(w.country);
    if (name) allCountryNames.add(name);
  }

  let countriesCreated = 0;
  for (const name of [...allCountryNames].sort()) {
    const normalized = name.toLowerCase();
    if (countryCache[normalized]) continue;

    const code = COUNTRY_CODES[name] || null;
    const doc = await Country.create({
      name,
      code,
      normalizedName: normalized,
      createdBy: admin._id,
    });
    countryCache[normalized] = doc;
    countriesCreated++;
    console.log(`  + ${name}${code ? ` (${code})` : ''}`);
  }
  console.log(`  Countries: ${countriesCreated} created, ${allCountryNames.size - countriesCreated} already existed`);

  // ─── 3. REGIONS from region files ─────────────────────────────────────────
  console.log('\n=== REGIONS ===');
  const regionCache = {}; // "countryNorm|regionNorm" → doc

  // Load existing regions into cache
  const existingRegions = await Region.find({}).populate('country');
  for (const r of existingRegions) {
    if (r.country) {
      const key = `${r.country.normalizedName}|${r.normalizedName}`;
      regionCache[key] = r;
    }
  }

  let regionsCreated = 0;
  let appellationsCreated = 0;

  // Helper: resolve grape names to ObjectId array
  async function resolveGrapeIds(grapeNames) {
    const ids = [];
    for (const name of (grapeNames || [])) {
      const norm = normalizeString(name);
      let doc = grapeCache[norm];
      if (!doc) {
        try {
          doc = await Grape.create({
            name, normalizedName: norm, synonyms: [], createdBy: admin._id,
          });
          grapeCache[norm] = doc;
          grapesCreated++;
        } catch (err) {
          doc = await Grape.findOne({ normalizedName: norm });
          if (doc) grapeCache[norm] = doc;
        }
      }
      if (doc) ids.push(doc._id);
    }
    return ids;
  }

  let regionsUpdated = 0;

  for (const rf of REGION_FILES) {
    const data = loadJSON(rf.file);
    const countryName = translateCountry(data.country);
    if (!countryName) continue;

    const countryNorm = countryName.toLowerCase();
    const countryDoc = countryCache[countryNorm];
    if (!countryDoc) { console.warn(`  Country not found: ${countryName}`); continue; }

    const isAppellationFormat = rf.format === 'appellations';

    for (const reg of data.regions) {
      // Region name differs by format
      const regionName = reg.name || reg.region;
      const translatedRegion = translateRegion(regionName);
      const regionNorm = normalizeString(translatedRegion);
      const regionKey = `${countryNorm}|${regionNorm}`;

      // Build metadata for parent region (simple format has region-level metadata)
      const parentMeta = {};
      if (!isAppellationFormat) {
        parentMeta.prestigeLevel = reg.prestigeLevel || null;
        if (reg.agingRules && Object.keys(reg.agingRules).length > 0) {
          parentMeta.agingRules = {
            legalMinMonths: reg.agingRules.legal_min_months || null,
            notes: reg.agingRules.notes || null,
          };
        }
        parentMeta.typicalGrapes = await resolveGrapeIds(reg.grapes);
      }

      let regionDoc = regionCache[regionKey];
      if (!regionDoc) {
        regionDoc = await Region.create({
          name: translatedRegion,
          normalizedName: regionNorm,
          country: countryDoc._id,
          hierarchy: [translatedRegion],
          ...parentMeta,
          createdBy: admin._id,
        });
        regionCache[regionKey] = regionDoc;
        regionsCreated++;
      } else if (!isAppellationFormat && !regionDoc.prestigeLevel && parentMeta.prestigeLevel) {
        // Update existing region with metadata
        await Region.updateOne({ _id: regionDoc._id }, { $set: parentMeta });
        regionsUpdated++;
      }

      // Import appellations / sub-regions as child regions
      const subItems = reg.appellations || reg.subRegions || [];
      for (const sub of subItems) {
        const subName = typeof sub === 'string' ? sub : sub.name;
        if (!subName) continue;

        const subNorm = normalizeString(subName);
        const subKey = `${countryNorm}|${subNorm}`;

        // Build metadata for appellation (rich format)
        const subMeta = {};
        if (typeof sub === 'object') {
          subMeta.classification = sub.classification || null;
          subMeta.styles = sub.styles || [];
          subMeta.prestigeLevel = sub.prestige_level || sub.prestigeLevel || null;
          if (sub.aging_rules) {
            subMeta.agingRules = {
              legalMinMonths: sub.aging_rules.legal_min_months || null,
              notes: sub.aging_rules.notes || null,
            };
          }
          // Resolve primary grapes → typicalGrapes
          if (sub.grapes) {
            const primary = sub.grapes.primary || sub.grapes || [];
            const permitted = sub.grapes.permitted || [];
            subMeta.typicalGrapes = await resolveGrapeIds(Array.isArray(primary) ? primary : []);
            subMeta.permittedGrapes = await resolveGrapeIds(Array.isArray(permitted) ? permitted : []);
          }
        }

        if (!regionCache[subKey]) {
          const subDoc = await Region.create({
            name: subName,
            normalizedName: subNorm,
            country: countryDoc._id,
            parentRegion: regionDoc._id,
            hierarchy: [translatedRegion, subName],
            ...subMeta,
            createdBy: admin._id,
          });
          regionCache[subKey] = subDoc;
          appellationsCreated++;
        } else if (typeof sub === 'object' && !regionCache[subKey].classification && subMeta.classification) {
          // Update existing appellation with metadata
          await Region.updateOne({ _id: regionCache[subKey]._id }, { $set: subMeta });
          regionsUpdated++;
        }
      }
    }
  }
  console.log(`  Regions: ${regionsCreated} created, ${regionsUpdated} updated with metadata`);
  console.log(`  Appellations/sub-regions: ${appellationsCreated} created`);

  // ─── 4. WINES ─────────────────────────────────────────────────────────────
  console.log('\n=== WINES ===');

  // Load existing normalizedKeys to skip duplicates efficiently
  const existingKeys = new Set();
  const cursor = WineDefinition.find({}, { normalizedKey: 1 }).lean().cursor();
  for await (const doc of cursor) {
    existingKeys.add(doc.normalizedKey);
  }
  console.log(`  Existing wine definitions: ${existingKeys.size}`);

  let winesCreated = 0;
  let winesSkipped = 0;
  let winesNoProducer = 0;
  let winesNoType = 0;
  let winesDuplicate = 0;

  // Batch for performance
  const BATCH_SIZE = 200;
  let batch = [];

  for (const w of winesRaw) {
    // Skip wines without producer (required field)
    if (!w.producer) { winesNoProducer++; continue; }

    // Map category to type
    const wineType = mapCategoryToType(w.category);
    if (!wineType) { winesNoType++; continue; }

    // Translate country
    const countryName = translateCountry(w.country);
    if (!countryName) { winesSkipped++; continue; }

    const countryNorm = countryName.toLowerCase();
    const countryDoc = countryCache[countryNorm];
    if (!countryDoc) { winesSkipped++; continue; }

    // Translate & find region (origin.level1)
    const rawRegion = w.origin?.level1 || null;
    const translatedRegionName = translateRegion(rawRegion);
    let regionDoc = null;
    if (translatedRegionName) {
      const regionNorm = normalizeString(translatedRegionName);
      const regionKey = `${countryNorm}|${regionNorm}`;
      regionDoc = regionCache[regionKey];

      // If region doesn't exist, create it on the fly
      if (!regionDoc) {
        regionDoc = await Region.create({
          name: translatedRegionName,
          normalizedName: regionNorm,
          country: countryDoc._id,
          hierarchy: [translatedRegionName],
          createdBy: admin._id,
        });
        regionCache[regionKey] = regionDoc;
        regionsCreated++;
      }
    }

    // Handle appellation (origin.level2)
    const appellation = w.origin?.level2 || '';

    // If there's an appellation, also ensure it exists as a child region
    if (appellation && regionDoc) {
      const appNorm = normalizeString(appellation);
      const appKey = `${countryNorm}|${appNorm}`;
      if (!regionCache[appKey]) {
        const appDoc = await Region.create({
          name: appellation,
          normalizedName: appNorm,
          country: countryDoc._id,
          parentRegion: regionDoc._id,
          hierarchy: [translatedRegionName, appellation],
          createdBy: admin._id,
        });
        regionCache[appKey] = appDoc;
        appellationsCreated++;
      }
    }

    // Resolve grape references
    const grapeIds = [];
    for (const gName of (w.grapes || [])) {
      const gNorm = normalizeString(gName);
      let grapeDoc = grapeCache[gNorm];
      if (!grapeDoc) {
        // Auto-create grape from wine data
        try {
          grapeDoc = await Grape.create({
            name: gName,
            normalizedName: gNorm,
            synonyms: [],
            createdBy: admin._id,
          });
          grapeCache[gNorm] = grapeDoc;
          grapesCreated++;
        } catch (err) {
          // Duplicate key — race condition or normalization clash, re-fetch
          grapeDoc = await Grape.findOne({ normalizedName: gNorm });
          if (grapeDoc) grapeCache[gNorm] = grapeDoc;
        }
      }
      if (grapeDoc) grapeIds.push(grapeDoc._id);
    }

    // Generate dedup key
    const normalizedKey = generateWineKey(w.name, w.producer, appellation);
    if (existingKeys.has(normalizedKey)) { winesDuplicate++; continue; }
    existingKeys.add(normalizedKey);

    batch.push({
      name: w.name,
      producer: w.producer,
      productNumber: w.productNumber || undefined,
      productNumberShort: w.productNumberShort || undefined,
      country: countryDoc._id,
      region: regionDoc?._id || null,
      appellation: appellation || undefined,
      grapes: grapeIds,
      type: wineType,
      normalizedKey,
      createdBy: admin._id,
    });

    if (batch.length >= BATCH_SIZE) {
      try {
        await WineDefinition.insertMany(batch, { ordered: false });
      } catch (err) {
        // Some may fail on duplicate normalizedKey — that's OK
        if (err.insertedDocs) {
          winesCreated += err.insertedDocs.length;
        }
      }
      winesCreated += batch.length;
      batch = [];

      if (winesCreated % 1000 < BATCH_SIZE) {
        process.stdout.write(`  Progress: ~${winesCreated} wines imported...\r`);
      }
    }
  }

  // Flush remaining batch
  if (batch.length > 0) {
    try {
      await WineDefinition.insertMany(batch, { ordered: false });
      winesCreated += batch.length;
    } catch (err) {
      if (err.insertedDocs) {
        winesCreated += err.insertedDocs.length;
      }
    }
  }

  console.log(`\n  Wines created: ~${winesCreated}`);
  console.log(`  Skipped (no producer): ${winesNoProducer}`);
  console.log(`  Skipped (non-wine category): ${winesNoType}`);
  console.log(`  Skipped (duplicate key): ${winesDuplicate}`);
  console.log(`  Skipped (other): ${winesSkipped}`);
  console.log(`  Additional grapes auto-created from wine data: ${grapesCreated - (grapesData.grapes.length)}`);
  console.log(`  Additional regions auto-created from wine data: ${regionsCreated}`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  const totalCountries = await Country.countDocuments();
  const totalRegions = await Region.countDocuments();
  const totalGrapes = await Grape.countDocuments();
  const totalWines = await WineDefinition.countDocuments();

  console.log('\n=== DATABASE TOTALS ===');
  console.log(`  Countries: ${totalCountries}`);
  console.log(`  Regions:   ${totalRegions}`);
  console.log(`  Grapes:    ${totalGrapes}`);
  console.log(`  Wines:     ${totalWines}`);

  console.log('\nSeed-data complete!');
  await mongoose.disconnect();
}

seedData().catch(err => {
  console.error('Seed-data failed:', err);
  process.exit(1);
});
