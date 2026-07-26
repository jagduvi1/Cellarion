/**
 * scan-country-plausibility — audit the Country taxonomy for junk entries
 * (support ticket 2026-07-26: a garbled label scan minted the country
 * "Espalda"). Read-only; changes nothing, has no --apply flag.
 *
 * For every Country document, reports:
 *   - whether the name is a recognized real-world country
 *     (utils/normalize.js isRecognizedCountry — same gate findOrCreateCountry
 *     now enforces at mint time; this script finds what predates the gate)
 *   - whether the ISO code is missing
 *   - how many registry wines and regions hang off it (cleanup blast radius)
 *
 * Suspect rows are listed with their creator and creation date so an admin can
 * decide: fix the name, merge into the real country, or delete. The actual
 * cleanup stays a deliberate admin action (taxonomy merge endpoint) — this
 * script never writes.
 *
 * Usage:
 *   docker exec cellarion-backend node src/scripts/scan-country-plausibility.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const WineDefinition = require('../models/WineDefinition');
const { isRecognizedCountry, isUnknownName } = require('../utils/normalize');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log('Connected. Mode: READ-ONLY (this script never writes)\n');

  const countries = await Country.find({}).sort({ name: 1 }).lean();
  const wineCounts = new Map(
    (await WineDefinition.aggregate([{ $group: { _id: '$country', n: { $sum: 1 } } }]))
      .map(r => [String(r._id), r.n])
  );
  const regionCounts = new Map(
    (await Region.aggregate([{ $group: { _id: '$country', n: { $sum: 1 } } }]))
      .map(r => [String(r._id), r.n])
  );

  const suspects = [];
  let missingCode = 0;
  for (const c of countries) {
    const flags = [];
    // "Unknown" placeholders predate the null-country convention; recognized
    // real countries may still legitimately lack their ISO code (data gap,
    // not junk) — report the two conditions separately.
    if (!isRecognizedCountry(c.name) && !isUnknownName(c.name)) flags.push('NOT-A-KNOWN-COUNTRY');
    if (!c.code) { missingCode += 1; flags.push('NO-ISO-CODE'); }
    if (flags.length) {
      suspects.push({
        id: String(c._id),
        name: c.name,
        flags,
        wines: wineCounts.get(String(c._id)) || 0,
        regions: regionCounts.get(String(c._id)) || 0,
        createdBy: String(c.createdBy),
        createdAt: c.createdAt,
      });
    }
  }

  console.log(`Countries: ${countries.length} total, ${suspects.length} flagged (${missingCode} missing an ISO code)\n`);
  for (const s of suspects) {
    console.log(`  "${s.name}" [${s.id}]  ${s.flags.join(', ')}`);
    console.log(`      wines=${s.wines}  regions=${s.regions}  createdBy=${s.createdBy}  createdAt=${s.createdAt?.toISOString?.() || s.createdAt}`);
  }
  if (!suspects.length) console.log('  (none — taxonomy is clean)');

  console.log('\nNothing was modified. Fix suspect rows via the admin taxonomy UI or the');
  console.log('taxonomy merge endpoint; wines/regions counts above are the blast radius.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Country plausibility scan failed:', err); process.exit(1); });
