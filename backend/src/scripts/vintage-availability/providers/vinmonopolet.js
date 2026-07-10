'use strict';

/**
 * Vinmonopolet (Norway) availability provider — PROOF OF CONCEPT.
 *
 * Uses the public website API `/vmpws/v2/vmp/products/search` which needs NO key.
 * Each vintage of a wine is a SEPARATE product with its own `code`; the vintage
 * year is embedded in the product NAME (e.g. "Ch. Margaux 2021"), not a dedicated
 * field, so we parse it out. `buyable === true` + `status === "aktiv"` means the
 * product is currently on the Norwegian market.
 *
 * Detection idea: search the wine, collect the set of buyable vintages, and the
 * caller diffs that set against the last-seen set (or checks a specific target
 * vintage) to know when a new vintage has been released.
 */

const BASE = 'https://www.vinmonopolet.no/vmpws/v2/vmp';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const YEAR_RE = /\b(19|20)\d{2}\b/;

function extractVintage(name) {
  const m = String(name || '').match(YEAR_RE);
  return m ? Number(m[0]) : null; // null = NV / unknown
}

// keep only search hits that plausibly belong to the queried wine
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics (château -> chateau)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !/^(19|20)\d{2}$/.test(t));
}

function nameMatches(query, name) {
  const q = tokenize(query);
  const n = new Set(tokenize(name));
  if (q.length === 0) return true;
  // require the last significant query token (usually the distinctive wine name)
  // plus at least half of the query tokens to appear
  const hits = q.filter((t) => n.has(t)).length;
  return n.has(q[q.length - 1]) || hits >= Math.ceil(q.length / 2);
}

/**
 * @param {string} wineQuery  free-text wine name, e.g. "Château Margaux"
 * @param {object} [opts]
 * @param {number} [opts.targetVintage]  year to check for (e.g. 2024)
 * @param {number} [opts.pageSize=50]
 * @param {function} [opts.fetchImpl=fetch]
 */
async function checkVinmonopolet(wineQuery, opts = {}) {
  const { targetVintage = null, pageSize = 50, fetchImpl = fetch } = opts;
  const url =
    `${BASE}/products/search?q=${encodeURIComponent(wineQuery)}` +
    `&pageSize=${pageSize}&fields=FULL`;

  const out = {
    source: 'vinmonopolet',
    country: 'NO',
    reachable: false,
    ok: false,
    query: wineQuery,
    targetVintage,
    matched: [],
    availableVintages: [],
    listedVintages: [],
    targetAvailable: null,
    error: null,
  };

  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    out.reachable = true;
    if (!res.ok) {
      out.error = `HTTP ${res.status}`;
      return out;
    }
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products : [];

    const matched = products
      .filter((p) => nameMatches(wineQuery, p.name))
      .map((p) => ({
        name: p.name,
        code: p.code,
        vintage: extractVintage(p.name),
        buyable: p.buyable === true,
        status: p.status,
        expired: p.expired === true,
        price: p.price && p.price.value,
        url: p.url ? `https://www.vinmonopolet.no${p.url}` : null,
      }));

    out.matched = matched;
    out.ok = true;

    const buyableYears = new Set();
    const listedYears = new Set();
    for (const m of matched) {
      if (m.vintage == null) continue;
      listedYears.add(m.vintage);
      if (m.buyable && !m.expired) buyableYears.add(m.vintage);
    }
    out.availableVintages = [...buyableYears].sort((a, b) => a - b);
    out.listedVintages = [...listedYears].sort((a, b) => a - b);

    if (targetVintage != null) {
      out.targetAvailable = buyableYears.has(Number(targetVintage));
    }
  } catch (err) {
    out.error = err.message || String(err);
  }
  return out;
}

module.exports = { checkVinmonopolet, extractVintage, nameMatches };
