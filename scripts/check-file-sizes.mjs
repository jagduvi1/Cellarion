#!/usr/bin/env node
// File-size ratchet. A file over the cap does not grow, and a file under it
// does not cross the line: new code goes into a sibling module instead.
//
//   node scripts/check-file-sizes.mjs            check (CI runs this)
//   node scripts/check-file-sizes.mjs --update   lower the baseline after a move PR
//
// Rules, checked against scripts/file-size-baseline.json:
//   - a baselined file that grew                      -> fail
//   - a baselined file that shrank, baseline not lowered -> fail (run --update)
//   - a baselined file that no longer exists           -> fail (run --update)
//   - a file not in the baseline over the cap          -> fail
//   - a file between the warning line and the cap      -> warning only
//
// --update only lowers entries, and drops a file that is gone or back under
// the cap (from then on the plain cap rule applies to it). It never raises an
// entry and never adds one: a defect fix that must add lines to a baselined
// file raises that entry by hand, with the reason in the PR body. Features
// never raise it. --seed (first run only) writes the baseline from scratch.
//
// Node built-ins only, so CI needs no npm ci for this job.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAP = 1500;
export const WARN = 1300;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'file-size-baseline.json');

const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TREES = ['backend/', 'frontend/', 'cellarion-mcp/', 'scripts/'];
// Vendored bundles are not ours to shrink.
const EXCLUDED = ['frontend/public/', 'node_modules/'];

export function countLines(text) {
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function trackedSourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => EXTENSIONS.has(extname(p)))
    .filter((p) => TREES.some((t) => p.startsWith(t)))
    .filter((p) => !EXCLUDED.some((e) => p.includes(e)));
}

export function measure(files) {
  const sizes = {};
  for (const f of files) {
    const full = join(ROOT, f);
    if (!existsSync(full)) continue; // deleted in the working tree, not yet committed
    sizes[f] = countLines(readFileSync(full, 'utf8'));
  }
  return sizes;
}

export function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(entries) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

/** Pure check: returns { errors, warnings, rows } for the given sizes and baseline. */
export function check(sizes, baseline) {
  const errors = [];
  const warnings = [];
  const rows = [];
  for (const [file, limit] of Object.entries(baseline)) {
    const lines = sizes[file];
    if (lines === undefined) {
      errors.push({ file, message: `is in the baseline but no longer exists: run --update` });
      continue;
    }
    rows.push({ file, lines, limit });
    if (lines > limit) {
      errors.push({ file, message: `grew from ${limit} to ${lines} lines (cap ${CAP}): new code goes into a sibling module` });
    } else if (lines < limit) {
      errors.push({ file, message: `shrank from ${limit} to ${lines} lines: lower the baseline with --update` });
    }
  }
  for (const [file, lines] of Object.entries(sizes)) {
    if (file in baseline) continue;
    if (lines > CAP) {
      rows.push({ file, lines, limit: CAP });
      errors.push({ file, message: `is ${lines} lines, over the ${CAP}-line cap and not in the baseline: split it or move the new code into a sibling module` });
    } else if (lines >= WARN) {
      rows.push({ file, lines, limit: CAP });
      warnings.push({ file, message: `is ${lines} lines, within ${CAP - lines} of the ${CAP}-line cap` });
    }
  }
  rows.sort((a, b) => b.lines - a.lines);
  return { errors, warnings, rows };
}

/** Pure update: returns the lowered baseline and a list of what changed, or the entries that would need raising. */
export function lowered(sizes, baseline) {
  const next = {};
  const changes = [];
  const needRaise = [];
  for (const [file, limit] of Object.entries(baseline)) {
    const lines = sizes[file];
    if (lines === undefined) { changes.push(`${file}: removed (file is gone)`); continue; }
    if (lines <= CAP) { changes.push(`${file}: removed (${lines} lines, back under the ${CAP}-line cap)`); continue; }
    if (lines < limit) { changes.push(`${file}: ${limit} -> ${lines}`); next[file] = lines; continue; }
    if (lines > limit) needRaise.push({ file, limit, lines });
    next[file] = limit;
  }
  return { next, changes, needRaise };
}

function summaryTable(rows) {
  const lines = ['| File | Lines | Limit |', '|---|---:|---:|'];
  for (const r of rows) lines.push(`| ${r.file} | ${r.lines} | ${r.limit} |`);
  return lines.join('\n');
}

function main(argv) {
  const sizes = measure(trackedSourceFiles());
  const baseline = readBaseline();

  if (argv.includes('--seed')) {
    const seeded = Object.fromEntries(Object.entries(sizes).filter(([, n]) => n > CAP));
    writeBaseline(seeded);
    console.log(`Seeded ${BASELINE_PATH} with ${Object.keys(seeded).length} files over ${CAP} lines.`);
    return 0;
  }

  if (argv.includes('--update')) {
    const { next, changes, needRaise } = lowered(sizes, baseline);
    writeBaseline(next);
    for (const c of changes) console.log(c);
    if (changes.length === 0) console.log('Baseline already current.');
    if (needRaise.length) {
      for (const r of needRaise) console.error(`${r.file}: ${r.lines} lines is over its baseline of ${r.limit}. --update never raises an entry; edit the JSON by hand and say why in the PR.`);
      return 1;
    }
    return 0;
  }

  const { errors, warnings, rows } = check(sizes, baseline);
  const gh = Boolean(process.env.GITHUB_ACTIONS);
  for (const w of warnings) console.log(gh ? `::warning file=${w.file}::${w.message}` : `warning: ${w.file} ${w.message}`);
  for (const e of errors) console.log(gh ? `::error file=${e.file}::${e.message}` : `error: ${e.file} ${e.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const head = `## File sizes (cap ${CAP}, warning from ${WARN})\n\n${errors.length} error(s), ${warnings.length} warning(s).\n\n`;
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, head + summaryTable(rows) + '\n', { flag: 'a' });
  }
  if (errors.length === 0) console.log(`File sizes OK: ${Object.keys(baseline).length} baselined file(s), ${warnings.length} near the cap.`);
  return errors.length ? 1 : 0;
}

// Case-insensitive so a Windows `C:` versus `c:` drive letter does not stop the CLI.
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) process.exit(main(process.argv.slice(2)));
