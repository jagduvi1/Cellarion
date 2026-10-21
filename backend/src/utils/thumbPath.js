/**
 * The card-size thumbnail PATH of an uploaded photo, or null.
 *
 * Backend port of frontend/src/utils/thumbUrl.js for answers that hand out a
 * path rather than a URL (GET /api/inventory, docs/ha-push-events.md §4):
 *
 *   /api/uploads/processed/<name>.<ext>  →  /api/uploads/thumbs/processed/<name>.<ext>.webp
 *   /api/uploads/originals/<name>.<ext>  →  /api/uploads/thumbs/originals/<name>.<ext>.webp
 *
 * services/thumbnails.js renders the thumbnail on first request. Unlike the
 * frontend helper, which returns anything else unchanged, this one returns
 * null for anything that is not a photo on THIS instance: an external link, a
 * data: URI, an absolute URL on another host (its thumbnail lives there, and
 * a bare path would point at us), a query string, an unknown folder or
 * extension. A client may then fetch only paths of the one shape this
 * returns — never a URL someone stored.
 *
 * Stored image references come in three forms (photoState.absoluteImageUrl,
 * the frontend's getWineImageUrl): an absolute URL, an /api/ path, or a bare
 * upload filename relative to /api/uploads ("processed/<uuid>.webp").
 *
 * Case-sensitive on purpose: uploads are stored under lowercase folders and
 * extensions (`<uuid>.<ext>`), and the integration client accepts exactly
 * ^/api/uploads/thumbs/(processed|originals)/[A-Za-z0-9_-]+\.(png|jpe?g|webp)\.webp$
 */
const UPLOAD_PATH = /^\/api\/uploads\/(processed|originals)\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/;

/** Hosts this instance answers on: BACKEND_URL and FRONTEND_URL (photoState's apiBase default otherwise). */
function ownHosts(env = process.env) {
  const hosts = new Set();
  for (const raw of [env.BACKEND_URL, env.FRONTEND_URL]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch { /* not a URL — ignored */ }
  }
  if (hosts.size === 0) hosts.add('cellarion.app');
  return hosts;
}

/**
 * @param {string} url  a stored image reference
 * @param {{ hosts?: Set<string> }} [opts]  the instance's own hosts (tests); default ownHosts()
 * @returns {string|null}
 */
function thumbPath(url, { hosts } = {}) {
  if (typeof url !== 'string' || !url || url.startsWith('data:')) return null;
  let path;
  if (/^https?:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.search || parsed.hash) return null;
    if (!(hosts || ownHosts()).has(parsed.host.toLowerCase())) return null;
    path = parsed.pathname;
  } else if (url.startsWith('/')) {
    path = url;
  } else if (/^[A-Za-z0-9_/.-]+$/.test(url)) {
    path = `/api/uploads/${url}`;
  } else {
    return null;
  }
  const m = UPLOAD_PATH.exec(path);
  return m ? `/api/uploads/thumbs/${m[1]}/${m[2]}.webp` : null;
}

module.exports = { thumbPath, ownHosts };
