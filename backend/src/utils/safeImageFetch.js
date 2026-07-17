/**
 * SSRF-guarded image download for server-side "attach image by URL" (the MCP
 * attach_bottle_image tool). The backend lives on a Docker network with
 * internal services (mongo, meilisearch, qdrant, rembg) and on a VM with
 * cloud metadata endpoints — a naive fetch(url) would let a caller aim
 * requests at any of them. Guards, in order:
 *
 *   - https only, default port only (443) — product/CDN images are https.
 *   - DNS is resolved FIRST and every A/AAAA record must be a public unicast
 *     address; the connection is then PINNED to the validated address via a
 *     custom `lookup`, so a DNS-rebinding flip between check and connect
 *     cannot redirect the socket.
 *   - Redirects are followed manually (≤3 hops), each hop re-validated from
 *     scratch — a public host 302ing to http://169.254.169.254 is refused.
 *   - 10s total timeout, response streaming capped at MAX_BYTES (abort, not
 *     buffer-then-check), Content-Type must look like an image when present
 *     (the byte-level truth is enforced downstream by sanitizeImageBuffer).
 *
 * Returns { buffer, contentType } or throws Error with a caller-safe message.
 */
const dns = require('dns');
const net = require('net');
const https = require('https');

const MAX_BYTES = 10 * 1024 * 1024; // matches the REST upload cap
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10 * 1000;

/** True for any address a server-side fetch must never touch. */
function isPrivateAddress(addr) {
  const family = net.isIP(addr);
  if (family === 4) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||           // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                              // multicast + reserved
    );
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(lower)) return true;    // fc00::/7 unique-local
    if (lower.startsWith('64:ff9b')) return true; // NAT64 — hides a v4 target
    // Refuse ANY IPv6 that embeds an IPv4 address: v4-mapped (::ffff:…) or the
    // deprecated v4-compatible (::a.b.c.d). A legitimate image host never
    // presents as one, and re-checking the inner v4 is a footgun — Node
    // normalizes ::ffff:169.254.169.254 to the HEX form ::ffff:a9fe:a9fe, which
    // a dotted-decimal-only check misses, smuggling the metadata endpoint past
    // the guard. Blanket-refuse instead of parsing every textual form.
    if (lower.startsWith('::ffff:') || /^::\d+\.\d+\.\d+\.\d+$/.test(lower) || /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true;
    // Belt-and-suspenders (SSRF re-audit): the branch above matches the CANONICAL
    // v4-mapped form, which is what URL and DNS canonicalization always emit. A
    // future refactor that fed a NON-canonical, zero-uncompressed textual form
    // (0:0:0:0:0:ffff:a9fe:a9fe) would slip past it. Structurally, ANY address
    // whose first five 16-bit groups are zero and whose sixth is 0 (v4-compatible)
    // or ffff (v4-mapped) embeds a v4 target — refuse it however the zeros are
    // written. A real public address cannot have those leading 80/96 bits, so
    // this never over-blocks a legitimate CDN (unlike a bare ':ffff:' substring
    // match, which would trip on any public address carrying an ffff group).
    const groups = expandV6Hex(lower);
    if (groups && groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) return true;
    return false;
  }
  return true; // not an IP at all — refuse
}

/**
 * Expand a pure-hex IPv6 literal (no embedded dotted-v4 tail — those are handled
 * by the regex branches above) to its eight 16-bit groups as numbers, or null if
 * it is not a well-formed hex-group address. Used only to classify the embedded
 * v4-mapped/compatible prefix independently of zero-compression.
 */
function expandV6Hex(addr) {
  if (addr.includes('.')) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/** Resolve a hostname and return a validated public address, or throw. */
async function resolvePublicAddress(hostname) {
  // URL.hostname keeps the brackets on an IPv6 literal ([::1]); strip them so
  // net.isIP classifies it as an address, not a name headed for DNS.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  // A literal IP in the URL skips DNS — validate it directly.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('URL resolves to a private or reserved address');
    return { address: host, family: net.isIP(host) };
  }
  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('URL hostname could not be resolved');
  }
  if (!records.length) throw new Error('URL hostname could not be resolved');
  // EVERY record must be public — a mixed set is an attack, not a CDN.
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new Error('URL resolves to a private or reserved address');
  }
  return records[0];
}

function fetchOnce(urlObj, pinned) {
  return new Promise((resolve, reject) => {
    // WALL-CLOCK deadline for the whole request (connect + headers + body).
    // `timeout: TIMEOUT_MS` below is only a socket-INACTIVITY timer: an origin
    // dribbling one byte per <10s under MAX_BYTES would evade it forever
    // (slowloris). This absolute timer bounds the total, independent of
    // activity. Cleared on settle so it never fires post-resolution.
    let settled = false;
    const finish = (fn) => (arg) => { if (settled) return; settled = true; clearTimeout(hardTimer); fn(arg); };
    const done = finish(resolve);
    const failed = finish(reject);
    const hardTimer = setTimeout(() => {
      req.destroy(new Error('image download exceeded the time limit'));
    }, TIMEOUT_MS);
    hardTimer.unref?.();

    const req = https.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname, // SNI + Host header stay the real name
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { 'User-Agent': 'Cellarion-ImageFetch/1.0 (+https://cellarion.app)' },
        timeout: TIMEOUT_MS,
        // The pin: whatever DNS says NOW, connect to the address validated above.
        lookup: (host, opts, cb) => cb(null, pinned.address, pinned.family),
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          return done({ redirect: res.headers.location || null });
        }
        if (status !== 200) {
          res.resume();
          return failed(new Error(`image URL answered HTTP ${status}`));
        }
        const ct = String(res.headers['content-type'] || '').toLowerCase();
        if (ct && !ct.startsWith('image/')) {
          res.destroy();
          return failed(new Error(`URL is not an image (content-type ${ct.split(';')[0]})`));
        }
        const declared = parseInt(res.headers['content-length'], 10);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          return failed(new Error('image is larger than the 10 MB limit'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return failed(new Error('image is larger than the 10 MB limit'));
          }
          chunks.push(c);
        });
        res.on('end', () => done({ buffer: Buffer.concat(chunks), contentType: ct || null }));
        res.on('error', (e) => failed(new Error(`download failed: ${e.message}`)));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('image download timed out')); });
    // Routes both a real transport error AND the hard-deadline req.destroy()
    // through the single-settle guard (its message is preserved).
    req.on('error', (e) => failed(new Error(`download failed: ${e.message}`)));
    req.end();
  });
}

/**
 * Download an image from a caller-supplied https URL with the full guard
 * stack. Throws Error with a message safe to surface to the caller.
 */
async function safeFetchImage(rawUrl) {
  let urlObj;
  try {
    urlObj = new URL(String(rawUrl));
  } catch {
    throw new Error('image_url is not a valid URL');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (urlObj.protocol !== 'https:') throw new Error('image_url must be https');
    if (urlObj.port && urlObj.port !== '443') throw new Error('image_url must use the default https port');
    if (urlObj.username || urlObj.password) throw new Error('image_url must not carry credentials');
    const pinned = await resolvePublicAddress(urlObj.hostname);
    const result = await fetchOnce(urlObj, pinned);
    if (result.redirect !== undefined) {
      if (!result.redirect) throw new Error('image URL redirected without a destination');
      urlObj = new URL(result.redirect, urlObj); // relative redirects resolve against the current hop
      continue; // full re-validation on the next loop
    }
    return result;
  }
  throw new Error(`image URL redirected more than ${MAX_REDIRECTS} times`);
}

module.exports = { safeFetchImage, isPrivateAddress, MAX_BYTES };
