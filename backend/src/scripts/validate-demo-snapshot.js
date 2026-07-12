/**
 * validate-demo-snapshot.js
 *
 * Registry-safety gate for the public-demo snapshot fixture
 * (src/data/demo-snapshot.json). The ephemeral-demo clone runs in registry-safe
 * "demoMode": it resolves each snapshot wine to an EXISTING WineDefinition and
 * SKIPS any that don't match (it never mints registry rows). So a wine that
 * doesn't already exist in the registry would silently vanish from the demo.
 *
 * Run this against the SAME database the demo will clone into (i.e. prod, or a
 * prod-registry copy) BEFORE committing a freshly-captured snapshot. It reports
 * every wine that would NOT resolve to an exact/confident existing match, so you
 * can add it to the registry or drop it from the snapshot.
 *
 * Usage (inside the backend container, against the target DB):
 *   MONGO_URI=... node src/scripts/validate-demo-snapshot.js
 *   MONGO_URI=... node src/scripts/validate-demo-snapshot.js path/to/other-snapshot.json
 *
 * Exit code 0 = every wine resolves (safe to commit); 1 = one or more misses.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { parseCellarExport, exportBottleToItem } = require('../services/cellarImport');
const { findOrCreateWine } = require('../services/findOrCreateWine');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';
const snapshotArg = process.argv[2];
const SNAPSHOT_PATH = snapshotArg
  ? path.resolve(process.cwd(), snapshotArg)
  : path.join(__dirname, '..', 'data', 'demo-snapshot.json');

// A throwaway ObjectId string for findOrCreateWine's createdBy param — matchOnly
// never creates, so nothing is ever attributed to it.
const PROBE_USER = new mongoose.Types.ObjectId().toString();

async function main() {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const { cellars } = parseCellarExport(raw);

  await mongoose.connect(MONGO_URI);
  console.log(`[validate-demo-snapshot] Checking ${SNAPSHOT_PATH} against ${MONGO_URI}\n`);

  let total = 0;
  const misses = [];

  for (const cellar of cellars) {
    for (const b of cellar.bottles || []) {
      const item = exportBottleToItem(b);
      const name = (item.wineName || item.producer || '').trim();
      if (!name) continue;
      total++;
      try {
        const { wine } = await findOrCreateWine(
          { name, producer: item.producer || name, country: item.country, region: item.region,
            appellation: item.appellation, type: item.type,
            grapes: Array.isArray(item.grapes) ? item.grapes : [] },
          PROBE_USER,
          { confirmCreate: true, matchOnly: true }
        );
        if (!wine) misses.push({ name, producer: item.producer, vintage: item.vintage });
      } catch (err) {
        misses.push({ name, producer: item.producer, vintage: item.vintage, error: err.message });
      }
    }
  }

  console.log(`Checked ${total} wine(s). Resolved: ${total - misses.length}. Missed: ${misses.length}.`);
  if (misses.length > 0) {
    console.log('\nThese wines would NOT resolve to an existing registry entry and would be SKIPPED in the demo:');
    for (const m of misses) {
      console.log(`  - ${m.producer ? m.producer + ' — ' : ''}${m.name} (${m.vintage || 'NV'})${m.error ? ' [' + m.error + ']' : ''}`);
    }
    console.log('\nFix: add each to the registry, or remove it from the snapshot, then re-run.');
  }

  await mongoose.disconnect();
  process.exit(misses.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[validate-demo-snapshot] Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
