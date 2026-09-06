/**
 * seed-canary-wines.js — registry lockdown (2026-09-06, layer L4).
 *
 * Loads the canary wines from a PRIVATE file that is never committed: the
 * canaries are plausible wines that do not exist, from producers that do not
 * exist, and their whole value is that a copier cannot tell them from real
 * rows. Listing them in an open-source repository would hand every copier
 * the filter, so this script knows only the SHAPE of a canary; the names
 * live in a JSON file the operator keeps outside the tree (password manager,
 * a root-only path on the VM) and passes in.
 *
 * File shape (an array):
 *   [{ "producer": "…", "name": "…", "country": "France", "region": "Northern Rhône",
 *      "appellation": "Saint-Joseph", "type": "red", "grapes": ["Syrah"],
 *      "profile": { "description": "…", "body": "medium", "tannin": "firm",
 *                   "acidity": "high", "sweetness": "dry",
 *                   "flavors": ["…"], "foodPairings": ["…"] } }, …]
 *
 * country / region / grapes are resolved by NAME against this instance's
 * taxonomy; an unknown country skips the row, an unknown region or grape is
 * left empty. Idempotent: upserts by producer + name. Canaries are excluded
 * from search membership, embedding and enrichment by their flag, so seeding
 * never touches Meilisearch, Qdrant or the AI budget.
 *
 * Usage (container running; copy the file in first, remove it after):
 *   docker exec cellarion-backend node src/scripts/seed-canary-wines.js --file /tmp/canaries.json --dry-run
 *   docker exec cellarion-backend node src/scripts/seed-canary-wines.js --file /tmp/canaries.json
 *   docker exec cellarion-backend node src/scripts/seed-canary-wines.js --list      (what is seeded now)
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LIST = argv.includes('--list');
const fileIdx = argv.indexOf('--file');
const FILE = fileIdx >= 0 ? argv[fileIdx + 1] : process.env.CANARY_FILE;

const TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified', 'orange'];
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byName = (Model, name) => (name ? Model.findOne({ name: new RegExp('^' + escapeRx(name) + '$', 'i') }).select('_id').lean() : null);

function validate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('the canary file must hold a non-empty array');
  rows.forEach((c, i) => {
    for (const k of ['producer', 'name', 'country', 'type']) {
      if (!c[k] || typeof c[k] !== 'string') throw new Error(`row ${i}: "${k}" is required`);
    }
    if (!TYPES.includes(c.type)) throw new Error(`row ${i}: type must be one of ${TYPES.join(', ')}`);
    if (!c.profile || typeof c.profile.description !== 'string' || !c.profile.description.trim()) {
      throw new Error(`row ${i}: profile.description is required — a canary without prose is not a convincing wine`);
    }
    if (c.grapes && !Array.isArray(c.grapes)) throw new Error(`row ${i}: grapes must be an array of names`);
  });
}

async function run() {
  await mongoose.connect(MONGO_URI);
  if (LIST) {
    const rows = await WineDefinition.find({ canary: true }).select('producer name slug country').populate('country', 'name').sort({ producer: 1 }).lean();
    console.log(`${rows.length} canary wine(s) seeded:`);
    for (const r of rows) console.log(`  ${r.producer} — ${r.name} (${r.country?.name || '?'}) /wines/${r.slug}`);
    await mongoose.disconnect();
    return;
  }
  if (!FILE) throw new Error('pass --file <path> (or CANARY_FILE) — the canary list is not in the repository, by design');
  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  validate(rows);

  let created = 0; let updated = 0; let skipped = 0;
  for (const c of rows) {
    const country = await byName(Country, c.country);
    if (!country) { console.log(`skip ${c.producer} — country "${c.country}" is not in this instance's taxonomy`); skipped++; continue; }
    const region = await byName(Region, c.region);
    const grapeIds = (await Promise.all((c.grapes || []).map((g) => byName(Grape, g)))).filter(Boolean).map((g) => g._id);
    const existing = await WineDefinition.findOne({ producer: c.producer, name: c.name });
    const fields = {
      name: c.name, producer: c.producer, country: country._id, region: region ? region._id : undefined,
      appellation: c.appellation || undefined, type: c.type, grapes: grapeIds, canary: true,
      aiProfile: { ...c.profile, source: 'curator', confidence: 0.9, generatedAt: new Date() },
    };
    const where = `${c.country}${region ? ', ' + c.region : ', region missing'}; ${grapeIds.length}/${(c.grapes || []).length} grapes`;
    if (DRY) { console.log(`${existing ? 'would update' : 'would create'} ${c.producer} — ${c.name} (${where})`); continue; }
    if (existing) { Object.assign(existing, fields); await existing.save(); updated++; }
    else { await new WineDefinition(fields).save(); created++; }
  }
  console.log(`canaries: ${created} created, ${updated} updated, ${skipped} skipped${DRY ? ' (dry run — nothing written)' : ''}`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error('seed-canary-wines failed:', e.message); process.exit(1); });
