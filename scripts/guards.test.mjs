// Tests for the two guard scripts that are ES modules. Node's own runner, so
// the CI job that runs them needs no npm ci:
//
//   node --test scripts/guards.test.mjs
//
// The scanner (repoHygiene.cjs) is tested from backend/src/repoHygiene.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankTestTitles, pragmas, cssCode, hashCommentCode, difference } from './check-comment-only.mjs';
import { check, lowered, countLines, CAP } from './check-file-sizes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let hasEsbuild = true;
try { createRequire(join(ROOT, 'frontend', 'package.json')).resolve('esbuild'); } catch { hasEsbuild = false; }

test('test titles: only a bare describe/it/test call is blanked', () => {
  assert.equal(blankTestTitles(`test('old name', () => {});`), `test('', () => {});`);
  assert.equal(blankTestTitles(`describe.only("suite", () => {});`), `describe.only("", () => {});`);
  // The input of a regular expression is code, and so is an interpolated title.
  assert.equal(blankTestTitles(`if (RE.test('abc')) run();`), `if (RE.test('abc')) run();`);
  assert.equal(blankTestTitles('test(`case ${n}`, fn);'), 'test(`case ${n}`, fn);');
  assert.equal(blankTestTitles('test(`plain`, fn);'), 'test(``, fn);');
});

test('pragmas: the comments a tool acts on are listed, others are not', () => {
  const text = [
    '/** @jest-environment jsdom */',
    '// an ordinary note',
    'const a = load(/* @vite-ignore */ url);',
    'foo(); // eslint-disable-line no-undef',
    '/* istanbul ignore next */',
  ].join('\n');
  assert.deepEqual(pragmas(text), ['/** @jest-environment jsdom */', '/* @vite-ignore */', '// eslint-disable-line no-undef', '/* istanbul ignore next */']);
  assert.deepEqual(pragmas('// just words\nconst x = 1;\n'), []);
});

test('stylesheets and hash-comment files compare without their comments', () => {
  assert.equal(cssCode('/* old */\n.a { color: red; }\n'), cssCode('/* reworded,\n   on two lines */\n.a {\n  color: red;\n}\n'));
  assert.notEqual(cssCode('.a { color: red; }'), cssCode('.a { color: blue; }'));
  assert.equal(hashCommentCode('# old\nlisten 80;\n\n  # note\nroot /srv;\n'), hashCommentCode('# reworded\n# twice\nlisten 80;\nroot /srv;\n'));
  // A comment that trails code is not stripped, so a change to it shows.
  assert.notEqual(hashCommentCode('listen 80; # old\n'), hashCommentCode('listen 80; # new\n'));
});

test('difference: every kind of file is proven or refused, never skipped', () => {
  assert.equal(difference('frontend/src/a.css', '/* a */.x{top:0}', '/* b */ .x { top: 0 }'), null);
  assert.match(difference('frontend/src/a.css', '.x{top:0}', '.x{top:1}'), /rules changed/);
  assert.equal(difference('frontend/nginx.conf', '# a\ngzip on;\n', '# b\ngzip on;\n'), null);
  assert.match(difference('frontend/nginx.conf', 'gzip on;\n', 'gzip off;\n'), /content changed/);
  assert.equal(difference('scripts/repo-hygiene-baseline.json', '{"a":1}', '{}'), null);
  for (const file of ['package.json', 'frontend/src/locales/en/translation.json', 'README.md', 'docker-compose.yml.bak', 'logo.png']) {
    assert.match(difference(file, 'a', 'b'), /cannot be proven/);
  }
});

test('difference: JavaScript is compared minified, and a pragma is part of the code', { skip: !hasEsbuild && 'esbuild is not installed (cd frontend && npm ci --legacy-peer-deps)' }, () => {
  assert.equal(difference('backend/src/a.js', '// old\nconst a = 1;\nmodule.exports = a;\n', '/* new */\nconst a = 1;\n\nmodule.exports = a;\n'), null);
  assert.match(difference('backend/src/a.js', 'module.exports = 1;\n', 'module.exports = 2;\n'), /code changed/);
  assert.match(difference('backend/src/a.js', 'run(); // eslint-disable-line no-undef\n', 'run();\n'), /pragma/);
  assert.equal(difference('backend/src/a.test.js', `test('old', () => {});\n`, `test('new', () => {});\n`, { testTitles: true }), null);
  assert.match(difference('backend/src/a.test.js', `test('old', () => {});\n`, `test('new', () => {});\n`), /code changed/);
  assert.match(difference('backend/src/a.test.js', `ok(RE.test('abc'));\n`, `ok(RE.test('abd'));\n`, { testTitles: true }), /code changed/);
});

test('file sizes: growth and a shrunk file fail, a broken baseline value fails instead of switching the check off', () => {
  const sizes = { 'big.js': CAP + 100, 'small.js': 10 };
  assert.deepEqual(check(sizes, { 'big.js': CAP + 100 }).errors, []);
  assert.match(check(sizes, { 'big.js': CAP + 50 }).errors[0].message, /grew/);
  assert.match(check(sizes, { 'big.js': CAP + 200 }).errors[0].message, /shrank/);
  assert.match(check(sizes, {}).errors[0].message, /over the/);
  for (const broken of ['x', {}, 0, -5, 1600.5, null]) {
    assert.match(check(sizes, { 'big.js': broken }).errors[0].message, /not a whole number/);
  }
});

test('file sizes: --update lowers, drops what is gone or back under the cap, and never raises', () => {
  const sizes = { 'shrunk.js': CAP + 10, 'under.js': CAP - 1, 'grown.js': CAP + 300 };
  const { next, needRaise } = lowered(sizes, { 'shrunk.js': CAP + 90, 'under.js': CAP + 5, 'gone.js': CAP + 5, 'grown.js': CAP + 200 });
  assert.deepEqual(next, { 'shrunk.js': CAP + 10, 'grown.js': CAP + 200 });
  assert.deepEqual(needRaise, [{ file: 'grown.js', limit: CAP + 200, lines: CAP + 300 }]);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\r\nb'), 2);
});
