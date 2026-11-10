#!/usr/bin/env node
// Proves that a branch changed no code: only comments, whitespace or (with
// --test-titles) the titles of describe/it/test blocks.
//
//   node scripts/check-comment-only.mjs [<base-ref>] [--test-titles]
//
// Every path that differs between the working tree and the point where it
// left <base-ref> (the merge base; default origin/main) must be provable:
//
//   .js .jsx .mjs .cjs   base and head are minified with esbuild and compared.
//                        Minification drops comments and whitespace, so
//                        identical output means identical code. A pragma
//                        comment (eslint-disable, @vite-ignore, @__PURE__,
//                        @jest-environment, …) is behaviour, so the pragmas
//                        must be the same too.
//   .css                 compared with block comments and whitespace removed.
//   .conf .yml .yaml     compared with full-line `#` comments and blank lines
//   .sh .py              removed. A comment that trails code is not stripped,
//                        so changing one fails: move it to its own line.
//   the two baselines    scripts/*-baseline.json may change; their own guards
//                        (check-file-sizes.mjs, repoHygiene.cjs) hold them.
//
// Any other changed path, and any added, deleted or renamed file, is not a
// comment-only change and fails. The working tree is what is compared, so run
// it with your changes committed or at least saved. esbuild comes from
// frontend/node_modules (a Vite dependency), so run
// `cd frontend && npm ci --legacy-peer-deps` first.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const HASH_COMMENT_EXTENSIONS = new Set(['.conf', '.yml', '.yaml', '.sh', '.py']);
const GUARDED_BASELINES = new Set(['scripts/file-size-baseline.json', 'scripts/repo-hygiene-baseline.json']);

// Blanks the title of describe/it/test (and .only/.skip), so a renamed test
// does not count as a code change. Only a call of the bare function: the
// `.test(` of a regular expression takes input, not a title. A template title
// that interpolates is left alone and shows up as a difference.
const TITLE_RE = /(?<![.\w$])(describe|it|test)(\.(?:only|skip))?\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
export function blankTestTitles(text) {
  return text.replace(TITLE_RE, (m, fn, mod, q, title) => (q === '`' && title.includes('${') ? m : `${fn}${mod || ''}(${q}${q}`));
}

// Comments a tool acts on. Removing or rewording one changes what lint, the
// bundler, the test runner or coverage does, and minification cannot see it.
const PRAGMA_RE = /eslint-(?:disable|enable|env)|@vite-ignore|[@#]__PURE__|@jest-environment|@vitest-environment|istanbul ignore|c8 ignore|v8 ignore|@ts-(?:ignore|expect-error|nocheck|check)|webpack[A-Z]\w+:|prettier-ignore|@license|@preserve/;
const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
/** The pragma comments of a JavaScript file, whitespace collapsed, in order. */
export function pragmas(text) {
  return (text.match(COMMENT_RE) || []).filter((c) => PRAGMA_RE.test(c)).map((c) => c.replace(/\s+/g, ' ').trim());
}

/** A stylesheet without its block comments and without whitespace. */
export function cssCode(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

/** A hash-comment file without full-line comments, blank lines and trailing whitespace. */
export function hashCommentCode(text) {
  return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n');
}

let esbuild;
function loadEsbuild() {
  if (esbuild) return esbuild;
  try {
    esbuild = createRequire(join(ROOT, 'frontend', 'package.json'))('esbuild');
  } catch {
    console.error('esbuild not found: run `cd frontend && npm ci --legacy-peer-deps` first.');
    process.exit(2);
  }
  return esbuild;
}

export function minified(text, file, { testTitles = false } = {}) {
  const loader = extname(file) === '.jsx' || file.startsWith('frontend/') ? 'jsx' : 'js';
  const input = testTitles && /\.test\.(js|jsx|mjs|cjs)$/.test(file) ? blankTestTitles(text) : text;
  return loadEsbuild().transformSync(input, { minify: true, loader, legalComments: 'none', logLevel: 'silent' }).code;
}

/**
 * Why `file` is not a comment-only change between `before` and `after`, or
 * null when it is one. Pure apart from the esbuild call for JavaScript.
 */
export function difference(file, before, after, { testTitles = false } = {}) {
  if (GUARDED_BASELINES.has(file)) return null;
  const ext = extname(file);
  if (JS_EXTENSIONS.has(ext)) {
    let same;
    try {
      same = minified(before, file, { testTitles }) === minified(after, file, { testTitles });
    } catch (err) {
      return `could not minify: ${err.message.split('\n')[0]}`;
    }
    if (!same) return 'code changed (minified output differs)';
    return JSON.stringify(pragmas(before)) === JSON.stringify(pragmas(after)) ? null : 'a pragma comment was added, removed or reworded';
  }
  if (ext === '.css') return cssCode(before) === cssCode(after) ? null : 'rules changed (the stylesheet differs outside its comments)';
  if (HASH_COMMENT_EXTENSIONS.has(ext)) {
    return hashCommentCode(before) === hashCommentCode(after) ? null : 'content changed outside full-line # comments';
  }
  return 'this kind of file cannot be proven comment-only';
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  const testTitles = argv.includes('--test-titles');
  const ref = argv.find((a) => !a.startsWith('--')) || 'origin/main';
  // The point where this branch left the base, so commits that landed on the
  // base since then are not read as changes made here.
  const base = git('merge-base', ref, 'HEAD').trim();
  const rows = git('-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-z', base, '--').split('\0');
  let failed = 0;
  let proven = 0;
  for (let i = 0; i < rows.length - 1;) {
    const code = rows[i++];
    const file = code[0] === 'R' || code[0] === 'C' ? (i++, rows[i++]) : rows[i++];
    let why;
    if (code[0] !== 'M') {
      why = `${code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'renamed'} file: not a comment-only change`;
    } else {
      const full = join(ROOT, file);
      why = difference(file, git('show', `${base}:${file}`), existsSync(full) ? readFileSync(full, 'utf8') : '', { testTitles });
    }
    if (why) { console.log(`::error file=${file}::${why}`); failed++; } else proven++;
  }
  if (failed === 0) console.log(`Comment-only: ${proven} changed file(s) carry the same code as ${ref}${testTitles ? ' (test titles ignored)' : ''}.`);
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) process.exit(main(process.argv.slice(2)));
