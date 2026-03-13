/**
 * Strips all HTML tags from a user-supplied string to prevent XSS in rendered output.
 * Uses a linear character-by-character scan instead of regex to avoid ReDoS.
 * Returns the original value unchanged if it is null/undefined/empty.
 */
const STRIP_HTML_MAX_LEN = 10_000;

function stripHtml(str) {
  if (!str) return str;
  // Reject excessively long strings to prevent CPU exhaustion (loop bound injection)
  if (str.length > STRIP_HTML_MAX_LEN) {
    throw new Error(`Input exceeds maximum allowed length of ${STRIP_HTML_MAX_LEN} characters`);
  }
  let result = '';
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
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

module.exports = { stripHtml, isSafeUrl };
