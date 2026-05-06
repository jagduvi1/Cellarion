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

// Hook: enforce safe link targets. The backend already does this on save
// (sanitize-html simpleTransform), but we set it again here so any link that
// somehow bypassed the backend still gets the safety attrs at render time.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/**
 * Sanitize HTML for safe `dangerouslySetInnerHTML` rendering. Returns the
 * cleaned HTML string. Use exclusively with content authored through the
 * DiscussionComposer — never with arbitrary user input from elsewhere.
 */
export function sanitizeForumRender(html) {
  if (typeof html !== 'string' || !html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    USE_PROFILES: { html: true }
  });
}

export const FORUM_ALLOWED_TAGS = ALLOWED_TAGS;
