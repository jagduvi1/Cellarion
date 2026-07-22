const { normalizeString, normalizeProducerKey, tokenize } = require('./normalize');

/**
 * Detect and strip a redundant producer prefix from a wine name.
 *
 * AI import lookups often store names like "Meerlust Chardonnay" for producer
 * "Meerlust" — the registry convention is a producer-free name ("Chardonnay").
 *
 * The prefix only counts when it is followed by a separator (whitespace or a
 * hyphen/dash), so producer "Chateau" does NOT flag "Chateauneuf-du-Pape".
 *
 * @param {string} name     - the wine's current name
 * @param {string} producer - the wine's producer
 * @returns {string|null} the cleaned name, or null when the name doesn't start
 *   with the producer (case-insensitive) or nothing meaningful would remain.
 */
function stripProducerPrefix(name, producer) {
  const n = typeof name === 'string' ? name.trim() : '';
  const p = typeof producer === 'string' ? producer.trim() : '';
  if (!n || !p) return null;
  if (n.length <= p.length + 1) return null;
  if (!n.toLowerCase().startsWith(p.toLowerCase())) return null;

  const rest = n.slice(p.length);
  // The character right after the prefix must be a separator, otherwise the
  // producer is merely a substring of a longer word.
  if (!/^[\s\-–—]/.test(rest)) return null;

  const remainder = rest.replace(/^[\s\-–—]+/, '').trim();
  return remainder.length > 0 ? remainder : null;
}

/**
 * The suffix twin: "Fiano di Avellino Mastroberardino" for producer
 * "Mastroberardino" → "Fiano di Avellino". Same guards mirrored — the char
 * right BEFORE the suffix must be a separator, and something meaningful must
 * remain. (Symmetric with the prefix rule, a hyphen counts as a separator;
 * an admin reviews every rename the scan proposes.)
 */
function stripProducerSuffix(name, producer) {
  const n = typeof name === 'string' ? name.trim() : '';
  const p = typeof producer === 'string' ? producer.trim() : '';
  if (!n || !p) return null;
  if (n.length <= p.length + 1) return null;
  if (!n.toLowerCase().endsWith(p.toLowerCase())) return null;

  const rest = n.slice(0, n.length - p.length);
  if (!/[\s\-–—]$/.test(rest)) return null;

  const remainder = rest.replace(/[\s\-–—]+$/, '').trim();
  return remainder.length > 0 ? remainder : null;
}

/**
 * Strip the producer from either END of a wine name (prefix checked first).
 * The ONE entry point for the create-time canonicalization, the admin
 * producer-in-name scan and the strip endpoint — so "which embeddings count"
 * can never drift between them. Returns the cleaned name or null.
 */
function stripProducerName(name, producer) {
  return stripProducerPrefix(name, producer) ?? stripProducerSuffix(name, producer);
}

/**
 * Variant-tolerant twin of stripProducerPrefix: strips the producer's
 * COMPARISON-KEY tokens off the FRONT of a name, so the exact-string blind
 * spot — name "Felton Road Block 3 Pinot Noir" with producer "Felton Road
 * Wines Ltd" — still canonicalizes (registry duplicate analysis 2026-07-22:
 * every observed variant embed was a prefix).
 *
 * Rules, in order:
 *   - Leading words that normalize away entirely (house/stop words: "Fattoria",
 *     "La", "Weingut") may precede the key run — they belong to the producer
 *     reference even though the comparison key drops them.
 *   - The FULL key-token run must then match word-for-word (normalized), so a
 *     partial producer overlap never strips.
 *   - Something meaningful must remain.
 *   - Suffixes are deliberately NOT handled here: legitimate wine names END
 *     with the producer key ("Les Forts de Latour" — Château Latour), so
 *     suffix stripping stays exact-string only (stripProducerSuffix).
 *
 * Operates on whitespace-split display words and compares their normalized
 * forms, so the remainder keeps its original casing and punctuation.
 *
 * @returns {string|null} the cleaned name, or null when no safe strip applies.
 */
function stripProducerKeyPrefix(name, producer) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return null;
  const keyTokens = normalizeProducerKey(producer || '').split(' ').filter(Boolean);
  if (keyTokens.length === 0) return null;

  const words = n.split(/\s+/);
  let start = 0;
  while (start < words.length && tokenize(words[start]).length === 0) start += 1;
  if (start + keyTokens.length >= words.length) return null; // nothing meaningful would remain
  for (let i = 0; i < keyTokens.length; i++) {
    if (normalizeString(words[start + i]) !== keyTokens[i]) return null;
  }

  const remainder = words.slice(start + keyTokens.length).join(' ').replace(/^[\s\-–—]+/, '').trim();
  return remainder.length > 0 ? remainder : null;
}

module.exports = { stripProducerPrefix, stripProducerSuffix, stripProducerName, stripProducerKeyPrefix };
