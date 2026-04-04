/**
 * IndexNow — notify search engines instantly when content changes.
 * https://www.indexnow.org/
 *
 * Fire-and-forget: failures are logged but never block the caller.
 */

const INDEXNOW_KEY = process.env.INDEXNOW_KEY;
const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';
const ENDPOINT = 'https://api.indexnow.org/IndexNow';

let host;
try {
  host = new URL(SITE_URL).host;
} catch {
  host = 'cellarion.app';
}

/**
 * Submit one or more URLs to IndexNow.
 * @param {string|string[]} urls — full URL(s) or path(s) starting with /
 */
function submitUrls(urls) {
  if (!INDEXNOW_KEY) return;

  const urlList = (Array.isArray(urls) ? urls : [urls]).map(u =>
    u.startsWith('http') ? u : `${SITE_URL}${u}`
  );

  const body = JSON.stringify({
    host,
    key: INDEXNOW_KEY,
    keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
    urlList
  });

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })
    .then(r => {
      if (!r.ok) console.warn(`[indexnow] ${r.status} for ${urlList.length} URL(s)`);
    })
    .catch(err => {
      console.warn('[indexnow] submit failed:', err.message);
    });
}

module.exports = { submitUrls };
