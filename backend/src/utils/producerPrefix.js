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

module.exports = { stripProducerPrefix };
