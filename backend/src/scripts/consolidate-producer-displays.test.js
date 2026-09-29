/**
 * scripts/consolidate-producer-displays — the script runs on require (it is a
 * CLI), so this reads its source. The wine projection must carry every field
 * profileInputsSnapshot() compares plus aiProfile itself: without them the
 * "snapshot follows the spelling" step never sees a current snapshot, and the
 * next enrichment sweep regenerates every renamed profile as stale — an AI
 * spend per wine and a fresh generatedAt that drops curated ones back into
 * the low-confidence queue (release audit 2026-09-29).
 */
const fs = require('fs');
const path = require('path');

const SNAPSHOT_INPUTS = ['name', 'producer', 'country', 'region', 'appellation', 'classification', 'type', 'grapes'];

test('the wine projection carries aiProfile and every profile-snapshot input, and the query uses it', () => {
  const src = fs.readFileSync(path.join(__dirname, 'consolidate-producer-displays.js'), 'utf8');
  const m = src.match(/const WINE_SELECT = '([^']+)'/);
  expect(m).not.toBeNull();
  const fields = new Set(m[1].split(/\s+/));
  for (const f of [...SNAPSHOT_INPUTS, 'aiProfile']) expect(fields.has(f)).toBe(true);
  expect(src).toMatch(/\.select\(WINE_SELECT\)/);
});

test('the snapshot inputs listed here are the ones profileInputsSnapshot() reads', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'enrichmentJob.js'), 'utf8');
  const fn = src.slice(src.indexOf('function profileInputsSnapshot('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const f of SNAPSHOT_INPUTS) expect(body).toMatch(new RegExp(`wine\\.${f}\\b`));
});
