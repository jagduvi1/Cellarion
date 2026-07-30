/**
 * READ-ONLY sweep of the curated Appellation collection for ref integrity
 * (code audit 2026-07-30: "appellation region not checked against country").
 *
 * The write surfaces now enforce, via appellationRefsError, that an
 * appellation's region belongs to its country and that both refs exist — but
 * ~880 docs were created before the guard (seed script, joint-review
 * promotions, admin UI). The seed script grouped regions per country so those
 * are structurally safe; this verifies the whole collection rather than
 * assuming it.
 *
 * Reports, never writes:
 *   - region docs pointing at a DIFFERENT country than the appellation's
 *   - dangling country refs (id no longer exists)
 *   - dangling region refs (id no longer exists)
 *
 * Any hit is fixed by hand in Admin → Taxonomy (re-point or clear the region)
 * — with wine counts this small, a write mode would be more risk than typing.
 *
 *   docker exec cellarion-backend node src/scripts/check-appellation-region-country.js
 */

const mongoose = require('mongoose');
const Appellation = require('../models/Appellation');
const Country = require('../models/Country');
const Region = require('../models/Region');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const docs = await Appellation.find({}).select('name country region').lean();
  const countryIds = [...new Set(docs.map(d => String(d.country)).filter(Boolean))];
  const regionIds = [...new Set(docs.map(d => d.region && String(d.region)).filter(Boolean))];

  const [countries, regions] = await Promise.all([
    Country.find({ _id: { $in: countryIds } }).select('name').lean(),
    Region.find({ _id: { $in: regionIds } }).select('name country').lean(),
  ]);
  const countryById = new Map(countries.map(c => [String(c._id), c]));
  const regionById = new Map(regions.map(r => [String(r._id), r]));

  let mismatches = 0, danglingCountry = 0, danglingRegion = 0;
  for (const d of docs) {
    const country = countryById.get(String(d.country));
    if (!country) {
      danglingCountry += 1;
      console.log(`DANGLING COUNTRY  "${d.name}" (${d._id}) → country ${d.country} does not exist`);
    }
    if (!d.region) continue;
    const region = regionById.get(String(d.region));
    if (!region) {
      danglingRegion += 1;
      console.log(`DANGLING REGION   "${d.name}" (${d._id}) → region ${d.region} does not exist`);
    } else if (String(region.country) !== String(d.country)) {
      mismatches += 1;
      const regionCountry = countryById.get(String(region.country));
      console.log(
        `COUNTRY MISMATCH  "${d.name}" (${d._id}) is in ${country?.name || d.country} ` +
        `but its region "${region.name}" belongs to ${regionCountry?.name || region.country}`
      );
    }
  }

  console.log(`\nChecked ${docs.length} appellations (${regionIds.length} distinct regions referenced).`);
  console.log(`Mismatched regions: ${mismatches} · dangling country refs: ${danglingCountry} · dangling region refs: ${danglingRegion}`);
  if (mismatches + danglingCountry + danglingRegion === 0) console.log('All clean — the invariant already holds for existing data.');

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
