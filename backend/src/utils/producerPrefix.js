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

module.exports = { stripProducerPrefix, stripProducerSuffix, stripProducerName };
