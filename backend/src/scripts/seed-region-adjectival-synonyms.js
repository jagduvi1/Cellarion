/**
 * Adjectival region synonyms — so the place-as-producer gate sees the form
 * labels actually print.
 *
 * THE HOLE: findOrCreateWine's mint gate asks
 *   Region.exists({ $or: [{ normalizedName }, { normalizedSynonyms }] })
 * — an EXACT match. "Tokaji" is what a Hungarian label prints, the Region doc
 * is "Tokaj", and the two strings are not equal, so "Tokaji" walked into the
 * producer field of a shared-registry wine. Every adjectival label form has the
 * same hole: "Bordelais", "Riojano", "Alentejano", "Egri", "Wachauer" are how
 * their regions appear IN PRINT, and none of them matches its Region doc.
 *
 * The fix is data, not code: they are synonyms of regions the taxonomy already
 * holds, and `normalizedSynonyms` is exactly the field the gate already
 * queries. Adding them widens the gate, the cross-field producer-is-region
 * rule, and findOrCreateRegion's dedup (a label scan can no longer mint
 * "Tokaji" as a second region beside "Tokaj") in one write.
 *
 * INVENTS NOTHING. Every entry names a region that must ALREADY exist — the
 * script looks each one up and reports a miss instead of creating it — and
 * every synonym is a documented adjectival or same-language variant of that
 * region's own name, not a neighbouring place. Where a synonym already exists
 * as its OWN Region document the script refuses to touch it and reports it: two
 * documents for one place is a MERGE decision (services/taxonomyMerge), and
 * quietly making one an alias of the other would strand the wines pointing at
 * it.
 *
 * Dry-run by default; --apply writes. Idempotent — a synonym already present is
 * counted and skipped, so re-running after a taxonomy import is safe.
 *
 *   docker exec cellarion-backend node src/scripts/seed-region-adjectival-synonyms.js
 *   docker exec cellarion-backend node src/scripts/seed-region-adjectival-synonyms.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Region = require('../models/Region');
const Country = require('../models/Country');
const { normalizeString, resolveCountryName } = require('../utils/normalize');

/**
 * { region, country, synonyms[], why }
 *
 * `country` disambiguates same-named regions (Rioja exists in Spain AND
 * Argentina); a region name that resolves to more than one document without a
 * country match is skipped, never guessed.
 *
 * Kept deliberately short and defensible. The bar for an entry: the synonym is
 * the form PRINTED ON LABELS or the region's own name in another language of
 * the same country — never a sub-region, never a neighbouring appellation,
 * never a grape.
 */
const ENTRIES = [
  // ── Hungary — the adjectival form IS the label convention ("Tokaji Aszú",
  //    "Egri Bikavér", "Villányi Franc"); the region names are the bare towns.
  { region: 'Tokaj',      country: 'Hungary', synonyms: ['Tokaji'],            why: 'the label form — the row that started this' },
  { region: 'Eger',       country: 'Hungary', synonyms: ['Egri'],              why: 'adjectival label form ("Egri Bikavér")' },
  { region: 'Villány',    country: 'Hungary', synonyms: ['Villányi'],          why: 'adjectival label form' },
  { region: 'Szekszárd',  country: 'Hungary', synonyms: ['Szekszárdi'],        why: 'adjectival label form' },

  // ── Austria — the -er adjective is the everyday form on a label.
  { region: 'Wachau',     country: 'Austria', synonyms: ['Wachauer'],          why: 'adjectival label form' },
  { region: 'Kamptal',    country: 'Austria', synonyms: ['Kamptaler'],         why: 'adjectival label form' },
  { region: 'Kremstal',   country: 'Austria', synonyms: ['Kremstaler'],        why: 'adjectival label form' },

  // ── Germany — likewise, plus the umlaut-free spelling labels and importers
  //    use interchangeably.
  { region: 'Pfalz',      country: 'Germany', synonyms: ['Pfälzer', 'Pfalzer'], why: 'adjectival label form' },
  { region: 'Rheingau',   country: 'Germany', synonyms: ['Rheingauer'],         why: 'adjectival label form' },
  { region: 'Baden',      country: 'Germany', synonyms: ['Badener', 'Badische'], why: 'adjectival label forms' },
  // DELIBERATELY ABSENT: Mosel ← "Moselle" (audit L-9). Moselle is also a real
  // French AOC on the same river, and aliasing the string to the GERMAN region
  // would make a later mint resolve a Lorraine wine to Germany — a
  // cross-jurisdiction error the taxonomy cannot detect afterwards, and one
  // this list's own rule ("never a neighbouring place") forbids. If Moselle AOC
  // is ever added as its own Region, nothing needs re-deciding.

  // ── France — the regional NOUN a label uses for the wider area.
  { region: 'Bordeaux',   country: 'France',  synonyms: ['Bordelais'],          why: 'the regional noun/adjective for the Bordeaux area' },
  { region: 'Burgundy',   country: 'France',  synonyms: ['Bourgogne', 'Bourguignon'], why: 'French name + adjectival form' },
  { region: 'Alsace',     country: 'France',  synonyms: ['Alsacien'],           why: 'adjectival form' },
  { region: 'Provence',   country: 'France',  synonyms: ['Provençal', 'Provencal'], why: 'adjectival form, accented and not' },
  { region: 'Champagne',  country: 'France',  synonyms: ['Champenois'],         why: 'adjectival form' },

  // ── Spain — Castilian/Catalan variants and the -ano adjective.
  // "La Rioja" is NOT here (audit L-9): it is also an Argentine wine province,
  // and pointing the bare string at SPAIN's Rioja would silently resolve
  // Argentine wines to the wrong country. Same rule as Moselle above.
  { region: 'Rioja',      country: 'Spain',   synonyms: ['Riojano'],             why: 'adjectival form' },
  { region: 'Priorat',    country: 'Spain',   synonyms: ['Priorato'],            why: 'the Castilian spelling of the Catalan name' },
  { region: 'Jerez',      country: 'Spain',   synonyms: ['Jerezano'],            why: 'adjectival form' },

  // ── Portugal — "Vinho Regional Alentejano" and "Duriense" are official
  //    regional designations built on the adjective.
  { region: 'Alentejo',   country: 'Portugal', synonyms: ['Alentejano'],         why: 'the adjectival form used by the regional designation' },
  { region: 'Douro',      country: 'Portugal', synonyms: ['Duriense'],           why: 'the adjectival form used by the regional designation' },

  // ── Italy — the Italian name of the region and its adjective.
  { region: 'Tuscany',    country: 'Italy',   synonyms: ['Toscana', 'Toscano'],  why: 'Italian name + adjectival form' },
  { region: 'Piedmont',   country: 'Italy',   synonyms: ['Piemonte', 'Piemontese'], why: 'Italian name + adjectival form' },
  { region: 'Sicily',     country: 'Italy',   synonyms: ['Sicilia', 'Siciliano'], why: 'Italian name + adjectival form' },
  { region: 'Apulia',     country: 'Italy',   synonyms: ['Puglia', 'Pugliese'],   why: 'Italian name + adjectival form' },
  { region: 'Sardinia',   country: 'Italy',   synonyms: ['Sardegna', 'Sardo'],    why: 'Italian name + adjectival form' },
  { region: 'Abruzzo',    country: 'Italy',   synonyms: ['Abruzzese'],            why: 'adjectival form' },
  { region: 'Umbria',     country: 'Italy',   synonyms: ['Umbro'],                why: 'adjectival form' },
];

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  // One read of the whole collection: it is small (hundreds of docs), and every
  // check below — "does this region exist", "is this synonym already someone
  // else's name" — is a lookup against the same set.
  const regions = await Region.find({}).select('name normalizedName normalizedSynonyms synonyms country').lean();
  const byNormName = new Map();
  for (const r of regions) {
    const list = byNormName.get(r.normalizedName) || [];
    list.push(r);
    byNormName.set(r.normalizedName, list);
  }
  // Any normalized string already CLAIMED by a region — as its name or as one
  // of its synonyms. A candidate synonym landing on one of these is never
  // written blindly.
  const claimed = new Map();
  for (const r of regions) {
    for (const key of [r.normalizedName, ...(r.normalizedSynonyms || [])]) {
      if (key && !claimed.has(key)) claimed.set(key, r);
    }
  }

  const countries = await Country.find({}).select('name normalizedName').lean();
  const countryById = new Map(countries.map(c => [String(c._id), c.name]));
  const countryByNorm = new Map(countries.map(c => [c.normalizedName, c]));

  const planned = [];   // { region, synonym }
  const already = [];
  const missing = [];   // region not in the taxonomy — invented nothing, said so
  const ambiguous = []; // same name in several countries and none matched
  const conflicts = []; // the synonym is another region's own name/synonym

  for (const entry of ENTRIES) {
    const key = normalizeString(entry.region);
    const candidates = byNormName.get(key) || [];
    const wantCountry = normalizeString(resolveCountryName(entry.country));
    const countryDoc = countryByNorm.get(wantCountry);
    const matches = countryDoc
      ? candidates.filter(r => String(r.country) === String(countryDoc._id))
      : candidates;

    if (matches.length === 0) { missing.push(entry); continue; }
    if (matches.length > 1) { ambiguous.push(entry); continue; }
    const region = matches[0];

    for (const synonym of entry.synonyms) {
      const synKey = normalizeString(synonym);
      if (!synKey) continue;
      if ((region.normalizedSynonyms || []).includes(synKey) || region.normalizedName === synKey) {
        already.push({ region: region.name, synonym });
        continue;
      }
      const owner = claimed.get(synKey);
      if (owner && String(owner._id) !== String(region._id)) {
        // Two documents for one place is a MERGE, not an alias — aliasing would
        // leave the other document's wines pointing at a row nothing resolves to.
        conflicts.push({
          region: region.name, synonym,
          ownedBy: `${owner.name} (${countryById.get(String(owner.country)) || 'unknown country'})`,
        });
        continue;
      }
      planned.push({ region, synonym, why: entry.why });
      // Claim it within this run too, so two entries cannot both take one string.
      claimed.set(synKey, region);
    }
  }

  for (const p of planned) {
    console.log(`  + ${p.region.name}  ←  "${p.synonym}"   (${p.why})`);
  }
  for (const c of conflicts) {
    console.log(`  ! SKIPPED "${c.synonym}" for ${c.region} — already owned by ${c.ownedBy}; merge these two, don't alias`);
  }
  for (const m of missing) {
    console.log(`  · not in the taxonomy, nothing created: ${m.region} (${m.country})`);
  }
  for (const a of ambiguous) {
    console.log(`  · ambiguous, skipped: ${a.region} exists in several countries and "${a.country}" is not one of them`);
  }

  if (apply) {
    // Grouped per region so each document is saved once. .save(), not
    // updateOne: the pre-save hook is what keeps normalizedSynonyms in lockstep
    // with synonyms, and writing one without the other is how the gate ends up
    // querying a field that disagrees with the display list.
    const byRegion = new Map();
    for (const p of planned) {
      const list = byRegion.get(String(p.region._id)) || [];
      list.push(p.synonym);
      byRegion.set(String(p.region._id), list);
    }
    for (const [id, synonyms] of byRegion) {
      const doc = await Region.findById(id);
      if (!doc) continue;
      doc.synonyms = [...(doc.synonyms || []), ...synonyms];
      await doc.save();
    }
    console.log(`\nAPPLIED: ${planned.length} synonym(s) added across ${byRegion.size} region(s).`);
  } else {
    console.log(`\nDRY RUN: ${planned.length} synonym(s) would be added. Re-run with --apply to write.`);
  }
  console.log(
    `Summary — planned: ${planned.length}, already present: ${already.length}, ` +
    `conflicts: ${conflicts.length}, regions missing: ${missing.length}, ambiguous: ${ambiguous.length}`
  );

  await mongoose.disconnect();
})().catch(err => { console.error('seed-region-adjectival-synonyms failed:', err); process.exit(1); });
