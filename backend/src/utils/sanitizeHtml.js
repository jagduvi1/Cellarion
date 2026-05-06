const sanitize = require('sanitize-html');

// Single source of truth for the allowlist. The frontend's render-time
// sanitizer (DOMPurify) uses the same set of tags + attributes, so what the
// backend stores is exactly what the frontend renders — no mismatched
// expectations, no last-minute strip surprises.
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 's', 'u', 'blockquote', 'ul', 'ol', 'li', 'a'];

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target', 'rel']
};

const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

const SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_SCHEMES,
  // Strip empty attributes the user can't have meant (e.g. style, class)
  // and anything not in the allowlist above.
  disallowedTagsMode: 'discard',
  // Force every external link to open in a new tab and disclaim referrer +
  // ranking. Defense against tabnabbing + accidental SEO equity transfer
  // from the forum to spammy outbound domains.
  transformTags: {
    a: sanitize.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer nofollow'
    }, /* merge */ true)
  }
};

/**
 * Sanitize discussion / reply body HTML using the strict allowlist.
 * Returns a string of HTML safe to render with dangerouslySetInnerHTML
 * (and to round-trip through any future feed exporter).
 */
function sanitizeForumHtml(html) {
  if (typeof html !== 'string') return '';
  return sanitize(html, SANITIZE_OPTIONS);
}

// Tags that act as block/line boundaries — replaced with whitespace so the
// stripped text reflects what a reader actually sees ("Hello<br>world" is
// "Hello world", not "Helloworld"). Multiple consecutive boundaries collapse
// to one space, so a wall of `<br>` doesn't inflate the count.
const BLOCK_BOUNDARY_RE = /<\/?(br|p|div|li|blockquote|ul|ol)\s*\/?>/gi;

/**
 * Extract the visible-text length of a sanitized body — used for min/max
 * length validation. We validate against text length, not raw HTML length,
 * so a 5-character "Hello" wrapped in `<p><strong>...</strong></p>` (30 chars
 * of HTML) doesn't bypass the minimum-length check.
 */
function visibleTextLength(html) {
  if (typeof html !== 'string') return 0;
  const withSpaces = html.replace(BLOCK_BOUNDARY_RE, ' ');
  const text = sanitize(withSpaces, { allowedTags: [], allowedAttributes: {} });
  return text.replace(/\s+/g, ' ').trim().length;
}

module.exports = {
  sanitizeForumHtml,
  visibleTextLength,
  ALLOWED_TAGS,
  ALLOWED_ATTRIBUTES,
  ALLOWED_SCHEMES
};
