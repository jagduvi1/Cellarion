// What every crawler-rendered page shares: the site address, HTML escaping,
// JSON-LD serialising, the hreflang alternates and the rate limiter.
// Used by routes/og.js.
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../../utils/clientIp');
const { CRAWLER_LANGUAGES } = require('../../config/languages');

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';
const API_URL = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app';

/** Escape text for HTML: element content and double-quoted attribute values. */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serialize a JSON-LD object for safe embedding inside a <script
 * type="application/ld+json"> block. JSON.stringify does NOT escape `<`/`>`/`&`,
 * so a user-controlled field containing `</script>` (e.g. a wine name) could
 * otherwise break out of the script element. Escaping these as \uXXXX keeps the
 * JSON valid and the parsed data intact while making breakout impossible. (The
 * global CSP already blocks inline-script execution; this is defense-in-depth +
 * correct structured data for non-CSP crawlers.)
 */
function serializeJsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * hreflang alternates for a crawler-rendered page. One entry per language the
 * site is offered in, plus x-default. This and the SPA's SEOHead advertise the
 * same finished languages (config/languages.js).
 */
function hreflangLinks(pageUrl) {
  return [...CRAWLER_LANGUAGES, 'x-default']
    .map((lang) => `  <link rel="alternate" hreflang="${lang}" href="${esc(pageUrl)}" />`)
    .join('\n');
}

// ONE limiter for all crawler pages: a client's renders count across every
// page, so each page must use this instance and never build its own.
const ogLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  // Key on the masked client IP: the default keyGenerator uses the raw req.ip,
  // so an IPv6 client could rotate the low 64 bits of its /64 for an unbounded
  // number of (uncached, DB-hitting) OG renders. rateLimitKey collapses IPv6 to
  // its /64 and honours the CF-Connecting-IP trust model.
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  SITE_URL, API_URL, esc, serializeJsonLd, hreflangLinks, ogLimiter,
};
