#!/usr/bin/env node
// Proves that a branch changed no code: only comments, whitespace or (with
// --test-titles) the titles of describe/it/test blocks.
//
//   node scripts/check-comment-only.mjs [<base-ref>] [--test-titles]
//
// For every .js/.jsx/.mjs/.cjs file that differs between <base-ref> (default
// origin/main) and the working tree, the base and head versions are minified
// with esbuild and compared. Minification drops comments and whitespace, so
// identical output means identical code. An added, deleted or renamed file is
// never comment-only and fails. esbuild comes from frontend/node_modules
// (a Vite dependency), so `cd frontend && npm ci --legacy-peer-deps` first.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

const args = process.argv.slice(2);
const testTitles = args.includes('--test-titles');
const base = args.find((a) => !a.startsWith('--')) || 'origin/main';

let esbuild;
try {
  esbuild = createRequire(join(ROOT, 'frontend', 'package.json'))('esbuild');
} catch {
  console.error('esbuild not found: run `cd frontend && npm ci --legacy-peer-deps` first.');
  process.exit(2);
}

// Blanks the first string argument of describe/it/test (and .only/.skip), so a
// renamed test title does not count as a code change. Template titles with
// `${}` are left alone and will show up as a difference.
const TITLE_RE = /\b(describe|it|test)(\.(?:only|skip))?\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
export function blankTestTitles(text) {
  return text.replace(TITLE_RE, (m, fn, mod, q) => `${fn}${mod || ''}(${q}${q}`);
}

export function minified(text, file) {
  const loader = extname(file) === '.jsx' || file.startsWith('frontend/') ? 'jsx' : 'js';
  const input = testTitles && /\.test\.(js|jsx|mjs)$/.test(file) ? blankTestTitles(text) : text;
  return esbuild.transformSync(input, { minify: true, loader, legalComments: 'none', logLevel: 'silent' }).code;
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const status = git('diff', '--name-status', '-M', base, '--').split('\n').filter(Boolean);
  let failed = 0;
  let compared = 0;
  for (const row of status) {
    const [code, ...paths] = row.split('\t');
    const file = paths[paths.length - 1];
    if (!EXTENSIONS.has(extname(file))) continue;
    if (code[0] !== 'M') {
      console.log(`::error file=${file}::${code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'renamed'} file: not a comment-only change`);
      failed++;
      continue;
    }
    const before = git('show', `${base}:${file}`);
    const full = join(ROOT, file);
    const after = existsSync(full) ? readFileSync(full, 'utf8') : '';
    let same;
    try {
      same = minified(before, file) === minified(after, file);
    } catch (err) {
      console.log(`::error file=${file}::could not minify: ${err.message.split('\n')[0]}`);
      failed++;
      continue;
    }
    compared++;
    if (!same) {
      console.log(`::error file=${file}::code changed (minified output differs from ${base})`);
      failed++;
    }
  }
  if (failed === 0) console.log(`Comment-only: ${compared} changed file(s) minify identically to ${base}${testTitles ? ' (test titles ignored)' : ''}.`);
  return failed ? 1 : 0;
}

process.exit(main());
