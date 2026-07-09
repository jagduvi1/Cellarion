/**
 * Strips all HTML tags from a user-supplied string to prevent XSS in rendered output.
 * Uses a linear character-by-character scan instead of regex to avoid ReDoS.
 * Returns the original value unchanged if it is null/undefined/empty.
 */
const STRIP_HTML_MAX_LEN = 10_000;

function stripHtml(str) {
  if (!str) return str;
  // Routes pass raw body values, so a non-string here can be a crafted object
  // (e.g. { length: 1e12 }) whose .length would make the scan loop unbounded.
  if (typeof str !== 'string') return '';
  // Bound the scan to prevent CPU exhaustion (loop bound injection). Process
  // only the first STRIP_HTML_MAX_LEN chars and drop the rest — never throw:
  // routes call this on raw body fields BEFORE their length validation, so a
  // throw here would turn an oversized paste into a generic 500 instead of
  // the per-field 400 the downstream length checks produce.
  let result = '';
  let depth = 0;
  // Loop bound is the literal constant (not str.length) so the scan is
  // provably bounded regardless of the input's length.
  for (let i = 0; i < STRIP_HTML_MAX_LEN; i++) {
    if (i >= str.length) break;
    const ch = str[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      result += ch;
    }
  }
  return result.trim();
}

/**
 * Returns true if the URL uses only an http or https scheme.
 * Rejects javascript:, data:, and other potentially dangerous schemes.
 * Returns false for null/undefined/empty values.
 */
function isSafeUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Escapes special regex characters in a user-supplied string so it can
 * be safely used inside `new RegExp(...)` for literal matching.
 *
 * Total by design: coerces non-strings (including the object/array shapes
 * Express produces for `?x[$gt]=` query params) to a string first, so callers
 * can't crash it with a 500. null/undefined become ''.
 */
function escapeRegex(str) {
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitizes a user-supplied array of grape-name strings from a bottle import.
 *
 * Additive import contract (CellarTracker `item.grapes`): entries are already
 * trimmed client-side, but re-guard server-side — drop non-strings and empties,
 * strip HTML, cap each name at `maxLen` chars, dedupe case-insensitively and
 * keep at most `max` entries. Non-array input yields [] so callers never throw.
 *
 * Returns plain strings — taxonomy resolution (synonym mapping, find-or-create)
 * stays in services/findOrCreateWine.findOrCreateGrapes.
 */
function sanitizeGrapeNames(raw, { max = 5, maxLen = 100 } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (out.length >= max) break;
    if (typeof entry !== 'string') continue;
    const name = (stripHtml(entry) || '').trim().slice(0, maxLen);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

module.exports = { stripHtml, isSafeUrl, escapeRegex, sanitizeGrapeNames };
