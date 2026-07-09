/**
 * Regenerates the derived CellarTracker fixtures in ./generated/.
 *
 * Run from this directory:  node generate-variants.js
 *
 * Source fixtures (never edit by hand):
 *   webquery/ — real CellarTracker WebQuery output captured by the
 *               mathroule/cellartracker client test suite.
 *   bundle/   — verified 20-wine adversarial bundle (all files describe the
 *               same cellar, so counts reconcile across tables). Includes a
 *               REAL byte-level Windows-1252 CSV (CellarTracker_List_win1252.csv).
 *
 * Derived fixtures:
 *   generated/list_truncated25.tsv — a List export with EXACTLY 25 data rows.
 *     CellarTracker's browser export dialog defaults to "Only wines on this
 *     page" (= 25 rows), so a 25-row file is the signature of an accidentally
 *     truncated export. The importer must warn on it. Built by repeating rows
 *     of the bundle List table until there are exactly 25.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.join(here, 'bundle', 'CellarTracker_List.tsv'), 'utf8');
const lines = src.split(/\r?\n/).filter((l) => l.trim());
const header = lines[0];
const data = lines.slice(1);

const TARGET_ROWS = 25;
const out = [header];
for (let i = 0; out.length - 1 < TARGET_ROWS; i++) {
  out.push(data[i % data.length]);
}

fs.mkdirSync(path.join(here, 'generated'), { recursive: true });
fs.writeFileSync(path.join(here, 'generated', 'list_truncated25.tsv'), out.join('\n') + '\n');
console.log(`generated/list_truncated25.tsv written (${TARGET_ROWS} data rows)`);
