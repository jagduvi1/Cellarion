/**
 * Drift guard: every wine field mapBottlesForExport READS must be in the
 * populate `select` of the one query that feeds it (buildCellarDataExport).
 *
 * The mapper's own suite hands it fixtures, so it cannot see this: `colour`
 * was emitted by the mapper and never selected by the query, and no export
 * ever carried one (audit 2026-09-19). Source-level on purpose — the query
 * needs a live database, the rule does not.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'cellarExport.js'), 'utf8');

test('the export query selects every wine field the mapper reads', () => {
  const mapper = src.slice(src.indexOf('function mapBottlesForExport'), src.indexOf('async function buildCellarDataExport'));
  const query = src.slice(src.indexOf('async function buildCellarDataExport'));
  expect(mapper.length).toBeGreaterThan(0);

  // `const wine = b.wineDefinition || {}` → every `wine.<field>` the mapper touches.
  const read = [...new Set([...mapper.matchAll(/\bwine\??\.([a-zA-Z]+)/g)].map((m) => m[1]))]
    .filter((f) => f !== '_id');
  expect(read).toEqual(expect.arrayContaining(['name', 'type', 'colour', 'grapes']));

  // The wineDefinition populate's OWN select — its nested country/region/grapes
  // populates carry a `select: 'name'` each, so anchor on a wine-only field.
  const select = query.match(/select:\s*'([^']*\bproducer\b[^']*)'/);
  expect(select).not.toBeNull();
  const selected = select[1].split(/\s+/);

  expect(read.filter((f) => !selected.includes(f))).toEqual([]);
});
