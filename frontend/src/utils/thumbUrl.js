/**
 * The card-size thumbnail of an uploaded photo, or the URL unchanged.
 *
 * `…/api/uploads/processed/<uuid>.png` → `…/api/uploads/thumbs/processed/<uuid>.png.webp`
 * and the same for `originals/` (photos kept with their background — a
 * keep-background upload, an imported never-cropped photo; until 2026-09-27
 * those shipped full size to every card). A ~400×640 WebP the backend renders
 * on first request — services/thumbnails.js.
 * Anything else — an external link, a data:/blob: URL — has no thumbnail and
 * is returned as is. Callers fall back to the full URL when the thumbnail
 * fails to load (an older backend, a busy renderer).
 */
const UPLOAD = /^(.*)\/api\/uploads\/(processed|originals)\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/i;

export function thumbUrl(url) {
  if (typeof url !== 'string') return url;
  const m = UPLOAD.exec(url);
  return m ? `${m[1]}/api/uploads/thumbs/${m[2]}/${m[3]}.webp` : url;
}
