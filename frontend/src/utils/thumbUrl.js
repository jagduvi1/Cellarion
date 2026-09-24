/**
 * The card-size thumbnail of a processed upload, or the URL unchanged.
 *
 * `…/api/uploads/processed/<uuid>.png` → `…/api/uploads/thumbs/processed/<uuid>.png.webp`
 * (a ~400×640 WebP the backend renders on first request — services/thumbnails.js).
 * Anything else — an external link, an original, a data:/blob: URL — has no
 * thumbnail and is returned as is. Callers fall back to the full URL when the
 * thumbnail fails to load (an older backend, a busy renderer).
 */
const PROCESSED = /^(.*)\/api\/uploads\/processed\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/i;

export function thumbUrl(url) {
  if (typeof url !== 'string') return url;
  const m = PROCESSED.exec(url);
  return m ? `${m[1]}/api/uploads/thumbs/processed/${m[2]}.webp` : url;
}
