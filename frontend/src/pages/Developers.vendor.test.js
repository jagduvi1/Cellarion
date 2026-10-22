// @vitest-environment node
// The vendored Redoc viewer (scripts/vendor-redoc.mjs) is the file we
// reviewed: its hash is the one Developers.js records, it never fetches the
// remote Redocly logo, it carries its licences, and only the version the page
// loads is shipped.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REDOC_VERSION, REDOC_SHA256, REDOC_SRC } from './Developers';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));
const bundlePath = `${publicDir}${REDOC_SRC}`;

describe('vendored Redoc', () => {
  test('is the reviewed, patched bundle', () => {
    const bundle = readFileSync(bundlePath);
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(REDOC_SHA256);
    expect(bundle.toString('utf8')).not.toContain('cdn.redoc.ly');
  });

  test('ships its licences, and only the version the page loads', () => {
    const license = readFileSync(`${publicDir}/developers/redoc/${REDOC_VERSION}/LICENSE.txt`, 'utf8');
    expect(license).toContain(`redoc@${REDOC_VERSION}`);
    expect(license).toMatch(/MIT License/i);
    // Dotfiles (a Finder .DS_Store) are not versions.
    expect(readdirSync(`${publicDir}/developers/redoc`).filter((n) => !n.startsWith('.'))).toEqual([REDOC_VERSION]);
    expect(existsSync(`${publicDir}/developers/redoc/${REDOC_VERSION}/redoc.standalone.js.map`)).toBe(false);
  });
});
