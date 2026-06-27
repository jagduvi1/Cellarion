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

// ── Blog content ─────────────────────────────────────────────────────────────
// Blog posts are admin-authored in a rich-text (TipTap) editor and rendered on
// the SPA via DOMPurify. The crawler-facing OG page needs the SAME structure —
// headings, lists, images — so AI engines and search bots get a real document
// outline instead of a flat text blob. Richer allowlist than the forum, but
// still strips <script>, event handlers, and dangerous URL schemes.
const ALLOWED_TAGS_BLOG = [
  'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'em', 's', 'u',
  'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'code', 'pre',
  'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
];

const SANITIZE_OPTIONS_BLOG = {
  allowedTags: ALLOWED_TAGS_BLOG,
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
  // Demote any in-content <h1> to <h2> so the rendered OG page keeps a single
  // top-level <h1> (the post title from the template).
  transformTags: {
    h1: 'h2'
  }
};

/**
 * Sanitize blog post HTML for the crawler-facing OG page, preserving document
 * structure (headings, lists, images, tables) so search/AI engines can extract
 * it. Returns HTML safe to embed in the server-rendered page.
 */
function sanitizeBlogHtml(html) {
  if (typeof html !== 'string') return '';
  return sanitize(html, SANITIZE_OPTIONS_BLOG);
}

// Longest FAQ answer we put in JSON-LD — keeps the structured data tidy; the
// full prose still lives in the visible page body.
const FAQ_ANSWER_MAX = 1200;

// Plain text from HTML without ReDoS risk and without throwing on long input
// (unlike utils/sanitize.stripHtml, which caps at 10k). Decodes the handful of
// entities a rich-text editor emits so JSON-LD carries clean text, then
// collapses whitespace.
function htmlToText(html) {
  if (typeof html !== 'string') return '';
  let out = '';
  let depth = 0;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build FAQ Q&A pairs from question-style headings (h2–h4 whose visible text
 * ends with "?") and the body that follows each, up to the next heading. The
 * caller emits FAQPage JSON-LD only when there are enough pairs to be
 * meaningful. Pass sanitizeBlogHtml() output — input must be well-formed HTML.
 */
function extractFaqFromHtml(html) {
  if (typeof html !== 'string') return [];
  const headingRe = /<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const heads = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    heads.push({ start: m.index, end: headingRe.lastIndex, text: htmlToText(m[2]) });
  }
  const faqs = [];
  for (let i = 0; i < heads.length; i++) {
    const question = heads[i].text;
    if (!question.endsWith('?')) continue;
    const sliceEnd = (i + 1 < heads.length) ? heads[i + 1].start : html.length;
    let answer = htmlToText(html.slice(heads[i].end, sliceEnd));
    if (!answer) continue;
    if (answer.length > FAQ_ANSWER_MAX) answer = answer.slice(0, FAQ_ANSWER_MAX - 1).trim() + '…';
    faqs.push({ question, answer });
  }
  return faqs;
}

// Longest HowToStep body we put in JSON-LD — same budget as an FAQ answer.
const HOWTO_STEP_MAX = 1200;
// A step section is a top-level <h2> whose visible text opens with "Step <n>"
// (e.g. "Step 1 — Create a cellar"). The numbering prefix is stripped from the
// emitted step name. Only <h2> is scanned so a step's own <h3>/<h4> sub-headings
// stay inside the step body instead of splitting it.
const HOWTO_STEP_PREFIX_RE = /^step\s+\d+\s*[—:.)\-]*\s*/i;

/**
 * Build ordered HowTo steps from "Step N" <h2> headings and the body that
 * follows each, up to the next <h2>. The caller emits schema.org HowTo JSON-LD
 * only when there are >=2 steps — the same threshold the FAQ extractor uses, and
 * the visible steps live in the page body so the markup matches the page. Pass
 * sanitizeBlogHtml() output — input must be well-formed HTML.
 */
function extractHowToFromHtml(html) {
  if (typeof html !== 'string') return [];
  const headingRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const heads = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    heads.push({ start: m.index, end: headingRe.lastIndex, text: htmlToText(m[1]) });
  }
  const steps = [];
  for (let i = 0; i < heads.length; i++) {
    if (!HOWTO_STEP_PREFIX_RE.test(heads[i].text)) continue;
    const name = heads[i].text.replace(HOWTO_STEP_PREFIX_RE, '').trim() || heads[i].text;
    const sliceEnd = (i + 1 < heads.length) ? heads[i + 1].start : html.length;
    // A step body can span several blocks (paragraphs, list items, a sub-heading).
    // htmlToText() just drops tags, so turn block boundaries into spaces first —
    // otherwise "</p><h3>A</h3>" collapses to a run-on word.
    const body = html.slice(heads[i].end, sliceEnd)
      .replace(/<\/(p|li|h3|h4|blockquote|tr|div)>|<br\s*\/?>/gi, ' ');
    let text = htmlToText(body);
    if (!text) text = name; // a heading-only step still describes an action
    if (text.length > HOWTO_STEP_MAX) text = text.slice(0, HOWTO_STEP_MAX - 1).trim() + '…';
    steps.push({ name, text });
  }
  return steps;
}

module.exports = {
  sanitizeForumHtml,
  visibleTextLength,
  sanitizeBlogHtml,
  extractFaqFromHtml,
  extractHowToFromHtml,
  ALLOWED_TAGS,
  ALLOWED_TAGS_BLOG,
  ALLOWED_ATTRIBUTES,
  ALLOWED_SCHEMES
};
