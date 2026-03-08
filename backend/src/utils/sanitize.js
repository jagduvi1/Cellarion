/**
 * Strips all HTML tags from a user-supplied string to prevent XSS in rendered output.
 * Returns the original value unchanged if it is null/undefined/empty.
 */
function stripHtml(str) {
  if (!str) return str;
  let prev;
  do {
    prev = str;
    str = str.replace(/<[^>]*>/g, '');
  } while (str !== prev);
  return str.trim();
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
