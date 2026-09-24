import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest, BUILD_MARKER } from '../../vite-plugins/swPrecache.js';

describe('swPrecache buildManifest', () => {
  const files = [
    'index.html',
    'assets/index-abc.js',
    'assets/index-abc.css',
    'assets/inter-latin-400.woff2',
    'assets/inter-latin-400.woff',
    'assets/logo-x.png',
    'service-worker.js',
    'manifest.json',
  ];

  it('keeps the shell and every JS/CSS/woff2 asset, and nothing else', () => {
    const { files: out } = buildManifest(files, '<html>1</html>');
    expect(out).toEqual([
      '/index.html',
      '/assets/index-abc.css',
      '/assets/index-abc.js',
      '/assets/inter-latin-400.woff2',
    ]);
  });

  it('versions by file list and shell contents', () => {
    const a = buildManifest(files, '<html>1</html>').version;
    expect(buildManifest([...files].reverse(), '<html>1</html>').version).toBe(a); // order-independent
    expect(buildManifest(files, '<html>2</html>').version).not.toBe(a);
    expect(buildManifest([...files, 'assets/new-chunk.js'], '<html>1</html>').version).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it('the service worker source carries the marker the plugin replaces', () => {
    const sw = readFileSync(resolve(__dirname, '../../public/service-worker.js'), 'utf8');
    expect(sw.split(BUILD_MARKER)).toHaveLength(2);
  });
});
