#!/usr/bin/env node
/**
 * Phantom design-token guard.
 *
 * Fails the build if any `var(--x)` references a custom property that is never
 * defined anywhere in src/ — the class of bug fixed in audit Batch 3 (PR #689),
 * where a parallel `--bg-secondary`/`--text-*`/`--accent` namespace was used but
 * never declared, so those styles rendered transparent / broke in dark mode.
 *
 * A token counts as "defined" if it appears as:
 *   - a CSS declaration            `--x: value;`
 *   - a JS inline-style object key  `'--x': value` / `"--x": value`
 * so runtime-set tokens (e.g. --cellar-color, --wlm-*) are correctly allowed.
 *
 * Runs as `prebuild`, so `npm run build` (and the Docker frontend image build)
 * fails before shipping a phantom token. Run directly with `npm run lint:tokens`.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EXTS = new Set(['.css', '.js', '.jsx', '.ts', '.tsx']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const defined = new Set();
const used = new Map(); // token -> [{ file, line }]

const RE_CSS_DEF = /(--[a-zA-Z0-9-]+)\s*:/g;        // --x: value
const RE_JS_DEF = /['"](--[a-zA-Z0-9-]+)['"]\s*:/g; // '--x':  "--x":
const RE_USE = /var\(\s*(--[a-zA-Z0-9-]+)/g;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(RE_CSS_DEF)) defined.add(m[1]);
  for (const m of text.matchAll(RE_JS_DEF)) defined.add(m[1]);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE_USE)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push({ file, line: i + 1 });
    }
  });
}

const phantoms = [...used.keys()].filter(t => !defined.has(t)).sort();

if (phantoms.length === 0) {
  console.log(`✓ CSS token guard: ${used.size} custom properties used, all defined.`);
  process.exit(0);
}

console.error(`\n✗ CSS token guard: ${phantoms.length} phantom token(s) used but never defined:\n`);
for (const t of phantoms) {
  const first = used.get(t)[0];
  const rel = first.file.replace(/\\/g, '/').replace(/.*\/src\//, 'src/');
  console.error(`  var(${t})  — e.g. ${rel}:${first.line}  (${used.get(t).length} use(s))`);
}
console.error(`\nUse a real token (--color-*/--radius-*/--shadow-*/--drink-*), or define it.\n`);
process.exit(1);
