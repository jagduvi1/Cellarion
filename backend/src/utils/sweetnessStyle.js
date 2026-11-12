/**
 * The sweetness style's shared rules (WineDefinition.sweetnessStyle): who may
 * name one, which links are accepted, and the one shape it leaves the server
 * in. A util without dependencies, because the model, the write rule
 * (services/sweetnessWrite) and every reader must agree on each of them: a
 * value the rule accepts and the model refuses fails a save, and a value one
 * reader sends differently from another is two APIs.
 */

// Who may name a wine's sweetness style.
const SWEETNESS_STYLE_SOURCES = Object.freeze(['producer', 'trade']);
// The longest link stored, counted after normalising. The same limit as an
// evidence link on a correction (services/proposalFields URL_MAX; a test
// keeps the two equal).
const STYLE_URL_MAX = 500;

// The start every accepted link has before parsing: the scheme, two slashes
// and a host character. The URL parser forgives "https:merchant.example",
// "http:\\host" and a tab inside the scheme; this refuses them instead.
const LINK_START_RX = /^https?:\/\/[^\s/\\?#@]/i;

/**
 * A link as a style may store it: http or https, with a host, no credentials,
 * nothing that is not printable, normalised by the URL parser (what is
 * stored) and at most STYLE_URL_MAX characters after that. Returns
 * { ok: true, href } or { ok: false }.
 */
function normalizeStyleUrl(value) {
  if (typeof value !== 'string') return { ok: false };
  const raw = value.trim();
  if (!raw || raw.length > STYLE_URL_MAX * 4 || /[\p{C}\s]/u.test(raw) || !LINK_START_RX.test(raw)) return { ok: false };
  let parsed;
  try { parsed = new URL(raw); } catch { return { ok: false }; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return { ok: false };
  if (parsed.username || parsed.password) return { ok: false };
  const href = parsed.href;
  if (href.length > STYLE_URL_MAX) return { ok: false };
  return { ok: true, href };
}

/** Whether a stored link is one normalizeStyleUrl would store (the model's check). */
function isStoredStyleUrl(value) {
  const r = normalizeStyleUrl(value);
  return r.ok && r.href === value;
}

const isSource = (s) => typeof s === 'string' && SWEETNESS_STYLE_SOURCES.includes(s);

/**
 * The style as it leaves the server, from whatever a read holds: the stored
 * subdocument with its term populated, or the outgoing shape itself (a read
 * that already shaped it). Returns
 *   { state: 'none' }        no style: send null;
 *   { state: 'shaped', value } send { name, band, scale, regulated, source, sourceUrl };
 *   { state: 'unresolved' }  a style this read cannot vouch for — its term not
 *                            populated (or gone), or a source or link that
 *                            fails the rules: send NO key, never null and
 *                            never the stored shape.
 * Pure: no term table, no I/O, so the answer never depends on a cache.
 */
function styleShape(s) {
  if (s == null) return { state: 'none' };
  if (typeof s !== 'object') return { state: 'unresolved' };
  const shaped = s.term === undefined && typeof s.name === 'string';
  const term = shaped ? s : s.term;
  const url = shaped ? s.sourceUrl : s.url;
  if (!term || typeof term !== 'object' || typeof term.name !== 'string' || !term.name) return { state: 'unresolved' };
  if (!isSource(s.source) || !isStoredStyleUrl(url)) return { state: 'unresolved' };
  return {
    state: 'shaped',
    value: {
      name: term.name, band: term.band, scale: term.scale, regulated: term.regulated !== false,
      source: s.source, sourceUrl: url,
    },
  };
}

module.exports = { SWEETNESS_STYLE_SOURCES, STYLE_URL_MAX, normalizeStyleUrl, isStoredStyleUrl, styleShape };
