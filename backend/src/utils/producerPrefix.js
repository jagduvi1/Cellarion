const { normalizeString, normalizeProducerKey, tokenize } = require('./normalize');

/**
 * Multi-character connectives / prepositions that cannot legitimately END a
 * wine name. "La Viña de" (producer "Madaras") is the launch symptom of
 * leaving one stranded: an exact-string suffix strip lopped the producer off
 * the tail of "La Viña de Madaras" and kept the linking word (support ticket
 * 2026-07-26; 10 such rows on prod).
 *
 * Lives HERE (not in nameChecks.js, which consumes it) so the suffix-strip
 * guard below can use it without a circular require — nameChecks requires
 * this module for its rules.
 *
 * Deliberately EXCLUDES bare single letters (Château d'Yquem's dry white is
 * literally named "Y"; 'e'/'y' are Italian/Spanish "and") and bare ARTICLES
 * (la, le, el, il, the, der, die, das open wine names far more often than
 * they end them). The one single-letter exception is 'a' — as a standalone
 * TAIL token it is the Romance preposition ("Barolo Dedicato a Renina"
 * truncated to "…Dedicato a"), never a name ending. Widen only from measured
 * evidence — scripts/scan-name-anomalies.js reports the hit list — and bump
 * the dangling-name-tail rule id in nameChecks.js when you do (v1→v2:
 * +by/+sans/+a, registry audit 2026-07-26 — "The Barry Bros by" and
 * "Vin Sans" were still mintable).
 */
const DANGLING_TAIL_WORDS = new Set([
  'de', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'du', 'des',
  'da', 'dal', 'dalla', 'do', 'dos', 'das',
  'von', 'vom', 'van', 'of', 'and', 'et', 'und', 'och',
  'zu', 'zum', 'zur', 'au', 'aux', 'sur', 'sous', 'in', 'im', 'am',
  'con', 'com', 'avec', 'mit', 'med',
  'by', 'sans', 'a',
]);

/**
 * Articles that are fine at the END of a name on their own (see the note above
 * — they open names far more often than they end them, so a bare trailing
 * article is not evidence of a bad strip) but NOT when a connective precedes
 * them. "Clos de la Pape" with producer "Pape" strips to "Clos de la": the
 * article is last, so the single-token check never sees the "de" that is doing
 * the stranding. French/Italian ("de la", "di lo") and German ("von der",
 * "an der") wine names produce this shape routinely.
 */
const TAIL_ARTICLES = new Set([
  'la', 'le', 'les', 'el', 'los', 'las', 'il', 'lo', 'gli', 'the',
  'der', 'die', 'das', 'den', 'dem',
]);

/**
 * Does this candidate name end in a grammatically stranded connective?
 *
 * The ONE definition, shared by the create-time suffix-strip guard below and
 * the dangling-name-tail scan in nameChecks.js. They were separately written
 * last-token-only checks and so missed the same two-token shape (code audit
 * 2026-07-27, H2); keeping one implementation means the safety net cannot
 * again disagree with the guard it is meant to back up.
 *
 * @param {string} candidate - a proposed wine name
 * @returns {boolean} true when the tail is stranded and the strip must be refused
 */
function hasDanglingTail(candidate) {
  const tokens = normalizeString(candidate || '').split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (DANGLING_TAIL_WORDS.has(last)) return true;
  const prev = tokens[tokens.length - 2];
  return Boolean(prev && TAIL_ARTICLES.has(last) && DANGLING_TAIL_WORDS.has(prev));
}

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
  if (remainder.length === 0) return null;
  // Never leave a stranded connective at the tail: "La Viña de Madaras" with
  // producer "Madaras" must NOT strip to "La Viña de" — exactly how prod's 10
  // dangling-name rows were minted (support ticket 2026-07-26). When the
  // producer token is grammatically part of the name, the full phrase IS the
  // name (same family as "Les Forts de Latour"); keeping it beats writing a
  // broken one. canonicalizeWineName loops this function on every registry
  // write surface, so the guard closes the class at create time.
  if (hasDanglingTail(remainder)) return null;
  return remainder;
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

/**
 * Fully canonicalize a wine name against its producer: repeatedly strip the
 * exact producer (either end) and the producer key-token prefix until stable.
 * Returns the final name — the trimmed input when nothing strips. This is the
 * ONE step-0 shared by every registry write surface (findOrCreateWine, admin
 * create, wine-request approval), so what counts as "producer-free" can never
 * drift between them.
 */
function canonicalizeWineName(name, producer) {
  let n = typeof name === 'string' ? name.trim() : '';
  for (let rest = stripProducerName(n, producer) ?? stripProducerKeyPrefix(n, producer);
       rest;
       rest = stripProducerName(n, producer) ?? stripProducerKeyPrefix(n, producer)) {
    n = rest;
  }
  return n;
}

module.exports = {
  DANGLING_TAIL_WORDS,
  hasDanglingTail,
  stripProducerPrefix,
  stripProducerSuffix,
  stripProducerName,
  stripProducerKeyPrefix,
  canonicalizeWineName,
};
