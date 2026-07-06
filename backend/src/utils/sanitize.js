/**
 * Strips all HTML tags from a user-supplied string to prevent XSS in rendered output.
 * Uses a linear character-by-character scan instead of regex to avoid ReDoS.
 * Returns the original value unchanged if it is null/undefined/empty.
 */
const STRIP_HTML_MAX_LEN = 10_000;

function stripHtml(str) {
  if (!str) return str;
  // Bound the scan to prevent CPU exhaustion (loop bound injection). Process
  // only the first STRIP_HTML_MAX_LEN chars and drop the rest — never throw:
  // routes call this on raw body fields BEFORE their length validation, so a
  // throw here would turn an oversized paste into a generic 500 instead of
  // the per-field 400 the downstream length checks produce.
  const bounded = str.length > STRIP_HTML_MAX_LEN ? str.slice(0, STRIP_HTML_MAX_LEN) : str;
  let result = '';
  let depth = 0;
  for (let i = 0; i < bounded.length; i++) {
    const ch = bounded[i];
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

module.exports = { stripHtml, isSafeUrl, escapeRegex };
