const { normalizeString } = require('./normalize');

/**
 * Finding regions that are the same place under different names.
 *
 * WHY NOT THE WINE SCANNER'S APPROACH. The registry's duplicate-cluster scan
 * groups by producer and fuzzy-scores the names. That is right for wines and
 * useless here: the four documents the Loire was split across on 2026-08-31 —
 * "Loire Valley" (173 wines), "Vallée de la Loire" (32), "Loire" (2) and
 * "Val de Loire" (1) — share almost no characters. Trigram or Levenshtein
 * similarity between "loire valley" and "vallee de la loire" is low. A fuzzy
 * scan would never have found them, and a mint-time fuzzy check would not have
 * prevented them.
 *
 * WHAT ACTUALLY SEPARATES THEM. A region's identity lives in its proper nouns.
 * The difference between those four names is entirely articles, prepositions
 * and the word for "valley" in two languages. So: reduce a name to its
 * MEANINGFUL tokens, and two regions in the same country with the same
 * meaningful tokens are the same place.
 *
 * WHY THE STOP LIST IS SO SHORT. Every wine-relevant qualifier must stay
 * meaningful, or the scan proposes catastrophic merges:
 *
 *   haut / haute   Haut-Médoc is not Médoc
 *   côtes          Côtes de Bergerac is not Bergerac
 *   montagne       Montagne-Saint-Émilion is not Saint-Émilion
 *   lalande        Lalande-de-Pomerol is not Pomerol
 *   alto / bas     Alto Adige is not Adige
 *
 * So the list holds only articles, prepositions, and the handful of words that
 * literally mean "valley". Nothing that could name a cru, a commune or a bank
 * of a river.
 *
 * MEASURED AGAINST REAL DATA (prod, 2026-08-31). This rule proposes exactly
 * the four merges a human confirmed, and rejects every false positive a plain
 * substring overlap produced — including Jura/Jurançon, where "jura" is a
 * substring of "jurançon" but not a token of it. It is deliberately precise
 * rather than exhaustive: it does not catch "Savoie - Haute Savoie" or
 * "Gascony / South West France", both of which a human would merge. A scan an
 * admin trusts is worth more than one that surfaces 56 pairs of which five are
 * real, because the second kind stops being read.
 */

// Articles, prepositions and conjunctions across the languages the registry
// carries, plus the words that mean "valley" — and nothing else.
const STOP_TOKENS = new Set([
  // articles / prepositions / conjunctions
  'de', 'du', 'des', 'da', 'do', 'dos', 'das', 'di', 'del', 'della', 'delle',
  'dei', 'degli', 'la', 'le', 'les', 'el', 'los', 'las', 'lo', 'il', 'i', 'gli',
  'l', 'd', 'the', 'of', 'and', 'et', 'e', 'y', 'und', 'a', 'au', 'aux',
  // "valley", in the languages that name wine regions with it
  'valley', 'vallee', 'val', 'valle', 'vale', 'tal',
  // pure category words a file sometimes appends
  'region', 'regione', 'wine', 'wines', 'vin', 'vino',
]);

/**
 * The meaningful tokens of a taxonomy name, sorted and joined — two names with
 * the same signature name the same place.
 *
 * Falls back to the full token set when stripping would leave nothing: a
 * region genuinely called "Valle" must still compare against itself rather
 * than collapsing into every other emptied name.
 *
 * @param {string} name
 * @returns {string} '' when the name has no usable tokens at all
 */
function nameSignature(name) {
  // Split on the RAW name's separators, then normalize each token — not the
  // other way round. normalizeString removes punctuation rather than turning
  // it into a space, so normalizing first fuses "Languedoc-Roussillon" into
  // one token and it stops matching "Languedoc Roussillon" (caught by test,
  // 2026-08-31).
  const tokens = String(name || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => normalizeString(t))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  const meaningful = tokens.filter((t) => !STOP_TOKENS.has(t));
  const use = meaningful.length > 0 ? meaningful : tokens;
  return [...new Set(use)].sort().join(' ');
}

/**
 * Group taxonomy documents that share a signature within the same scope.
 *
 * Scope matters: two regions may share a name in different countries and be
 * unrelated places (a "Georgia" in the United States is not the country's
 * namesake), so a cluster never spans scopes.
 *
 * @param {Array<{_id: *, name: string, scope: *}>} docs
 * @returns {Array<{signature: string, scope: string, members: Array}>} clusters
 *   of two or more, largest first
 */
function findDuplicateClusters(docs) {
  const buckets = new Map();
  for (const doc of docs || []) {
    const signature = nameSignature(doc.name);
    if (!signature) continue;
    const key = `${String(doc.scope ?? '')}::${signature}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { signature, scope: String(doc.scope ?? ''), members: [] };
      buckets.set(key, bucket);
    }
    bucket.members.push(doc);
  }
  return [...buckets.values()]
    .filter((b) => b.members.length > 1)
    .sort((a, b) => b.members.length - a.members.length);
}

module.exports = { nameSignature, findDuplicateClusters, STOP_TOKENS };
