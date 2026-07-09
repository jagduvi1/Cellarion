import DOMPurify from 'dompurify';

// Defense-in-depth: the backend already sanitizes forum HTML on save with the
// same allowlist (see backend/src/utils/sanitizeHtml.js). We re-sanitize on
// render to handle two failure modes:
//   1. A bug in the backend sanitizer ever ships dangerous markup to clients.
//   2. Bodies that pre-date the migration (defensive against historical data).
//
// Tags + attributes MUST stay in lockstep with the backend allowlist; mismatch
// means content silently disappears at render time.
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 's', 'u', 'blockquote', 'ul', 'ol', 'li', 'a'];
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel'];

// Dedicated DOMPurify instance: the link-policy hook below is forum policy
// (forced target=_blank + nofollow). Registering it on the shared singleton
// would leak it into every other DOMPurify consumer (e.g. BlogPost, where
// nofollow on internal links is SEO-hostile) depending on module load order.
const forumPurify = DOMPurify(window);

// Hook: enforce safe link targets. The backend already does this on save
// (sanitize-html simpleTransform), but we set it again here so any link that
// somehow bypassed the backend still gets the safety attrs at render time.
forumPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/**
 * Sanitize HTML for safe `dangerouslySetInnerHTML` rendering. Returns the
 * cleaned HTML string. Use exclusively with content authored through the
 * DiscussionComposer — never with arbitrary user input from elsewhere.
 *
 * No USE_PROFILES here: DOMPurify documents that USE_PROFILES REPLACES an
 * explicit ALLOWED_TAGS/ALLOWED_ATTR config, which would silently disable
 * this allowlist (the exact bug this comment is guarding against).
 */
export function sanitizeForumRender(html) {
  if (typeof html !== 'string' || !html) return '';
  return forumPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
  });
}

/**
 * Extract plain text from a sanitized body. Uses DOMPurify with
 * ALLOWED_TAGS:[] + KEEP_CONTENT:true so all markup is stripped via a real
 * HTML parser (not regex). This handles malformed input like an unclosed
 * `<script` correctly — a hand-rolled `<[^>]+>` regex doesn't (CodeQL's
 * `js/incomplete-multi-character-sanitization` rule).
 *
 * Used for quote-preview snippets and visible-length counters; the actual
 * body is rendered via sanitizeForumRender, never as plain text.
 */
export function extractForumPlainText(html) {
  if (typeof html !== 'string' || !html) return '';
  const stripped = forumPurify.sanitize(html, { ALLOWED_TAGS: [], KEEP_CONTENT: true });
  return stripped.replace(/\s+/g, ' ').trim();
}
