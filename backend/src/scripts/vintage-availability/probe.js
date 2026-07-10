'use strict';

/* eslint-disable no-console */

/**
 * Vintage-availability PROBE / feasibility test.
 *
 * Answers the question: "can we detect that a given wine VINTAGE is on the market
 * right now, using free public sources?" It queries every available provider for a
 * wine and reports which vintages are currently available, and whether a specific
 * wanted vintage is available.
 *
 * Usage:
 *   node src/scripts/vintage-availability/probe.js "Château Margaux" 2022
 *   node src/scripts/vintage-availability/probe.js --selfcheck
 *
 * --selfcheck runs a fixed panel of well-known wines and exits non-zero if a
 * source is unreachable, so it doubles as a go/no-go feasibility check.
 *
 * NOTE: this is an on-demand probe that hits live external sites. It is NOT part
 * of the Jest suite (the offline logic in detect.js is covered by detect.test.js).
 */

const fs = require('fs');
const path = require('path');
const { mergeSources } = require('./detect');

// --- load whichever providers exist in ./providers ---
function loadProviders() {
  const dir = path.join(__dirname, 'providers');
  const providers = [];
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!file.endsWith('.js')) continue;
    const mod = require(path.join(dir, file));
    // each provider module exports one async check fn named check<Source>
    const fn = Object.values(mod).find((v) => typeof v === 'function' && /^check/.test(v.name));
    if (fn) providers.push({ name: file.replace(/\.js$/, ''), run: fn });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

async function probeWine(wineQuery, targetVintage, providers) {
  const results = await Promise.all(
    providers.map((p) =>
      p
        .run(wineQuery, { targetVintage })
        .catch((err) => ({ source: p.name, ok: false, reachable: false, error: err.message }))
    )
  );
  return results;
}

function fmtResult(r) {
  if (!r.reachable) return `  ✗ ${r.source.padEnd(14)} UNREACHABLE (${r.error || 'no response'})`;
  if (!r.ok) return `  ⚠ ${r.source.padEnd(14)} reachable but no data (${r.error || '—'})`;
  const avail = (r.availableVintages || []).join(', ') || '—';
  const tgt =
    r.targetAvailable == null ? '' : r.targetAvailable ? '  ← WANTED VINTAGE IS AVAILABLE ✅' : '';
  return `  ✓ ${r.source.padEnd(14)} available: [${avail}]${tgt}`;
}

async function runOne(wineQuery, targetVintage, providers) {
  console.log(`\n🍷 ${wineQuery}${targetVintage ? `  (wanted vintage: ${targetVintage})` : ''}`);
  const results = await probeWine(wineQuery, targetVintage, providers);
  for (const r of results) console.log(fmtResult(r));
  const merged = mergeSources(results);
  console.log(`  ── union of all sources: [${merged.unionAvailableVintages.join(', ') || '—'}]`);
  if (targetVintage != null) {
    const anyHas = results.some((r) => r.targetAvailable === true);
    console.log(
      `  ── VERDICT: vintage ${targetVintage} is ${anyHas ? 'ON THE MARKET now (released ✅)' : 'not found on any source yet'}`
    );
  }
  return results;
}

const SELFCHECK_PANEL = [
  { wine: 'Château Margaux', vintage: 2021 },
  { wine: 'Sassicaia', vintage: 2020 },
  { wine: 'Barolo Giacomo Conterno', vintage: 2019 },
];

async function selfcheck(providers) {
  console.log('=== SELF-CHECK: is each source usable right now? ===');
  const reach = {}; // source -> true if it ever returned data
  for (const { wine, vintage } of SELFCHECK_PANEL) {
    const results = await runOne(wine, vintage, providers);
    for (const r of results) reach[r.source] = reach[r.source] || r.ok;
  }
  console.log('\n=== SUMMARY ===');
  let allGood = true;
  for (const p of providers) {
    const ok = reach[p.name];
    if (!ok) allGood = false;
    console.log(`  ${ok ? 'USABLE ✅' : 'NOT USABLE ❌'}  ${p.name}`);
  }
  if (providers.length === 0) {
    console.log('  (no providers loaded)');
    allGood = false;
  }
  return allGood;
}

async function main() {
  const providers = loadProviders();
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--selfcheck') {
    const ok = await selfcheck(providers);
    process.exit(ok ? 0 : 1);
  }

  const wine = args[0];
  const vintage = args[1] ? Number(args[1]) : null;
  await runOne(wine, vintage, providers);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { probeWine, loadProviders };
