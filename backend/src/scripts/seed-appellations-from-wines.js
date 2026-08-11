/**
 * Seed the Appellation taxonomy from the appellation strings wines already
 * carry (registry strategy 2026-07-29, R2).
 *
 * The Appellation collection has been vestigial (8 docs) while ~4k wines
 * carry >1k distinct free-text strings. This script promotes the strings the
 * registry itself vouches for — each distinct normalized appellation used by
 * at least --min-wines wines (default 3, the same floor the public taxonomy
 * pages use) — into curated docs, so the write-time resolver
 * (services/appellationResolve.js) can start collapsing variants and the
 * admin unmatched queue shrinks to the long tail worth human eyes.
 *
 * Per group: name = the majority display spelling (ties → the spelling whose
 * earliest wine is oldest — same rule as producer unification), country = the
 * majority country among the group's wines, region = the majority region
 * among wines of that country when one covers >= half of them (else null —
 * an appellation is not forced under a region it only sometimes sits in).
 *
 * Groups already matched by an existing doc (name or synonym) are skipped;
 * so is anything below the floor — the point is to canonize what is clearly
 * established, not to bless every typo. The long tail stays free text and
 * surfaces in GET /api/admin/taxonomy/appellations/unmatched.
 *
 * Dry-run by default. --apply writes; --min-wines N overrides the floor.
 *
 *   docker exec cellarion-backend node src/scripts/seed-appellations-from-wines.js
 *   docker exec cellarion-backend node src/scripts/seed-appellations-from-wines.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Appellation = require('../models/Appellation');
const User = require('../models/User');
const { normalizeAppellationKey, normalizeAppellation } = require('../utils/normalize');

(async () => {
  const apply = process.argv.includes('--apply');
  const minIdx = process.argv.indexOf('--min-wines');
  const minWines = minIdx > -1 ? Math.max(1, parseInt(process.argv[minIdx + 1], 10) || 3) : 3;
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const [wines, existing, admin] = await Promise.all([
    WineDefinition.find({ appellation: { $nin: [null, ''] }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
      .select('appellation country region createdAt').lean(),
    Appellation.find({}).select('normalizedName normalizedSynonyms').lean(),
    User.findOne({ roles: 'admin' }).select('_id').lean(),
  ]);
  if (!admin) { console.error('ERR: no admin user found (createdBy is required)'); process.exit(1); }

  const matched = new Set();
  for (const a of existing) {
    if (a.normalizedName) matched.add(a.normalizedName);
    for (const s of a.normalizedSynonyms || []) matched.add(s);
  }

  // normalized → { spellings: Map<raw,{count,oldest}>, countries: Map<id,count>, regionsByCountry: Map<id, Map<regionId,count>>, total }
  const groups = new Map();
  for (const w of wines) {
    // Tier-strip BEFORE grouping: strings stored before the write-path guard
    // ("Ribera del Duero DO") must fold into their clean form, not become a
    // tier-suffixed taxonomy doc — found on the first prod-data dry run.
    const cleaned = normalizeAppellation(w.appellation) || w.appellation;
    const key = normalizeAppellationKey(cleaned);
    if (!key || matched.has(key)) continue;
    let g = groups.get(key);
    if (!g) { g = { spellings: new Map(), countries: new Map(), regionsByCountry: new Map(), total: 0 }; groups.set(key, g); }
    g.total += 1;
    const s = g.spellings.get(cleaned) || { count: 0, oldest: w.createdAt };
    s.count += 1;
    if (w.createdAt < s.oldest) s.oldest = w.createdAt;
    g.spellings.set(cleaned, s);
    const c = String(w.country || '');
    if (c) {
      g.countries.set(c, (g.countries.get(c) || 0) + 1);
      if (w.region) {
        let rm = g.regionsByCountry.get(c);
        if (!rm) { rm = new Map(); g.regionsByCountry.set(c, rm); }
        rm.set(String(w.region), (rm.get(String(w.region)) || 0) + 1);
      }
    }
  }

  const toCreate = [];
  let belowFloor = 0;
  for (const [key, g] of groups) {
    if (g.total < minWines) { belowFloor += 1; continue; }
    const spelling = [...g.spellings.entries()]
      .sort((a, b) => (b[1].count - a[1].count) || (a[1].oldest - b[1].oldest))[0][0];
    const countryEntry = [...g.countries.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!countryEntry) continue; // country is required on Appellation
    const [countryId, countryCount] = countryEntry;
    let regionId = null;
    const rm = g.regionsByCountry.get(countryId);
    if (rm) {
      const top = [...rm.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] * 2 >= countryCount) regionId = top[0];
    }
    toCreate.push({ key, name: spelling, countryId, regionId, wines: g.total });
  }
  toCreate.sort((a, b) => b.wines - a.wines);

  console.log(`[seed-appellations] ${apply ? 'APPLY' : 'DRY-RUN'} wineRows=${wines.length} distinctUnmatched=${groups.size} toCreate=${toCreate.length} belowFloor(min ${minWines})=${belowFloor} existingDocs=${existing.length}`);
  for (const c of toCreate) {
    console.log(`  + "${c.name}" (${c.wines} wines) country=${c.countryId}${c.regionId ? ` region=${c.regionId}` : ''}`);
  }

  if (apply) {
    let created = 0, conflicts = 0;
    for (const c of toCreate) {
      try {
        // .save(), not bulkWrite — the model hook maintains normalizedSynonyms
        // and the {country, normalizedName} unique index turns a race or a
        // cross-run repeat into a skipped conflict instead of a duplicate.
        const doc = new Appellation({
          name: c.name, normalizedName: c.key,
          country: c.countryId, region: c.regionId, createdBy: admin._id,
        });
        await doc.save();
        created += 1;
      } catch (err) {
        if (err.code === 11000) { conflicts += 1; continue; }
        console.warn(`  WARN "${c.name}": ${err.message}`);
      }
    }
    console.log(`[seed-appellations] created=${created} conflicts=${conflicts}`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
