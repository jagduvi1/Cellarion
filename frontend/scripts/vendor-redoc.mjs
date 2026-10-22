#!/usr/bin/env node
/**
 * Vendor the Redoc standalone viewer for /developers (pages/Developers.js).
 *
 *   node scripts/vendor-redoc.mjs 2.5.4
 *
 * Why vendored rather than an npm dependency: the page needs one file, and
 * the package would add about 100 dependencies to every frontend install.
 *
 * What it does:
 *  1. `npm pack redoc@<version>` into a temporary folder;
 *  2. checks the tarball against the integrity npm publishes for it;
 *  3. replaces the one remote image Redoc renders (the Redocly logo beside
 *     the "API docs by Redocly" credit, fetched from cdn.redoc.ly) with an
 *     empty source, so no visitor's browser contacts a third party; the
 *     credit link itself stays;
 *  4. writes the bundle and its licenses to
 *     public/developers/redoc/<version>/ — a new version is a new URL, as
 *     nginx caches every .js for a year.
 *
 * Then set REDOC_VERSION in src/pages/Developers.js, delete the old version's
 * folder, and run the tests (src/pages/Developers.vendor.test.js checks the
 * file and the patch).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: node scripts/vendor-redoc.mjs <version>, e.g. 2.5.4');
  process.exit(1);
}

const LOGO = 'https://cdn.redoc.ly/redoc/logo-mini.svg';
const frontend = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(join(tmpdir(), 'redoc-'));

try {
  const integrity = execFileSync(npm, ['view', `redoc@${version}`, 'dist.integrity'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  // Packed inside the temporary folder: no path argument, so a space in the
  // path cannot break the Windows shell call.
  const tgzName = execFileSync(npm, ['pack', `redoc@${version}`, '--silent'], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
  const tgz = join(work, tgzName);

  const [algo, expected] = integrity.split(/-(.*)/s);
  const actual = createHash(algo).update(readFileSync(tgz)).digest('base64');
  if (actual !== expected) throw new Error(`integrity mismatch for redoc@${version}: npm says ${integrity}, the tarball is ${algo}-${actual}`);

  // Relative names and cwd: GNU tar on Windows reads "C:" as a remote host.
  execFileSync('tar', ['-xzf', tgzName], { cwd: work });
  const pkg = join(work, 'package');
  const bundle = readFileSync(join(pkg, 'bundles', 'redoc.standalone.js'), 'utf8');

  const hits = bundle.split(LOGO).length - 1;
  if (hits !== 1) throw new Error(`expected the Redocly logo URL exactly once in the bundle, found ${hits}: review the patch for this version`);
  const patched = bundle.replace(LOGO, '');

  const out = join(frontend, 'public', 'developers', 'redoc', version);
  // A version's URL is cached for a year (nginx, the service worker): never
  // change the bytes behind one. A new patch needs a new version folder.
  if (existsSync(out)) throw new Error(`${out} already exists: a version that has shipped must not change. Delete it only if it never shipped.`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'redoc.standalone.js'), patched);
  writeFileSync(join(out, 'LICENSE.txt'), [
    `Redoc ${version} (https://github.com/Redocly/redoc), vendored from the npm package`,
    `redoc@${version} (${integrity}). One change: the remote Redocly logo URL is`,
    'replaced with an empty image source (see frontend/scripts/vendor-redoc.mjs).',
    '',
    readFileSync(join(pkg, 'LICENSE'), 'utf8').trim(),
    '',
    '---- Third-party licenses bundled in redoc.standalone.js ----',
    '',
    readFileSync(join(pkg, 'bundles', 'redoc.standalone.js.LICENSE.txt'), 'utf8').trim(),
    '',
  ].join('\n'));

  const sha = createHash('sha256').update(patched).digest('hex');
  console.log(`vendored redoc@${version} to ${out}`);
  console.log(`patched bundle sha256: ${sha}`);
  console.log('Next: set REDOC_VERSION and REDOC_SHA256 in src/pages/Developers.js, remove the old folder, run npm test.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
