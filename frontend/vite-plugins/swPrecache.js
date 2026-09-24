import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The literal the service worker carries in source; the build replaces it.
export const BUILD_MARKER = '/*__CELLARION_BUILD__*/null';

// What an offline copy of the app needs: the shell, every JS/CSS chunk (lazy
// routes included — a page never opened online must still open offline) and
// the woff2 fonts. The .woff twins are skipped: every supported browser takes
// woff2, and they would add ~0.7 MB for nothing.
const PRECACHE = /^assets\/.+\.(?:js|css|woff2)$/;

/**
 * Pure part, unit-tested: the build manifest the service worker precaches.
 * `version` hashes the file list and the shell's bytes, so it changes with
 * every deploy that changes anything the worker would serve.
 */
export function buildManifest(fileNames, indexHtml) {
  const files = fileNames.filter((f) => PRECACHE.test(f)).sort();
  const version = crypto
    .createHash('sha256')
    .update(files.join('\n'))
    .update('\0')
    .update(indexHtml || '')
    .digest('hex')
    .slice(0, 16);
  // indexRefs: the build's own files that index.html loads (its entry script
  // and stylesheet). The worker refuses to store an index.html that does not
  // reference them — one from another build must never sit next to this
  // build's bundles. References, not a hash of the file: a CDN may rewrite
  // bits of HTML in transit, never the asset names.
  const indexRefs = [...new Set((String(indexHtml || '').match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) || []))].sort();
  return { version, indexRefs, files: ['/index.html', ...files.map((f) => `/${f}`)] };
}

/**
 * Stamps the build manifest into dist/service-worker.js (copied verbatim from
 * public/). Two effects:
 *  - the worker knows exactly which hashed files make up THIS build, so it can
 *    precache the app for offline use (#1355) without guessing;
 *  - the worker's bytes change on every deploy, so browsers pick up the new
 *    worker (and with it the new file list) instead of keeping the old one.
 * The dev server never runs it: there the marker stays null and the worker
 * precaches nothing.
 */
export default function swPrecache() {
  let outDir;
  return {
    name: 'cellarion-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    // From what is actually on disk, after everything is written: some chunk
    // names in the in-memory bundle change after generateBundle (8 of ~180 in
    // a real build), and a single wrong name fails the whole all-or-nothing
    // offline download.
    closeBundle: {
      order: 'post',
      handler() {
        const indexPath = path.join(outDir, 'index.html');
        if (!fs.existsSync(indexPath)) return;
        const assets = fs.readdirSync(path.join(outDir, 'assets')).map((f) => `assets/${f}`);
        const manifest = buildManifest(assets, fs.readFileSync(indexPath, 'utf8'));
        const swPath = path.join(outDir, 'service-worker.js');
        const source = fs.readFileSync(swPath, 'utf8');
        if (!source.includes(BUILD_MARKER)) {
          throw new Error(`[sw-precache] ${BUILD_MARKER} not found in ${swPath}`);
        }
        fs.writeFileSync(swPath, source.replace(BUILD_MARKER, JSON.stringify(manifest)));
      },
    },
  };
}
