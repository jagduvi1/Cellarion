/**
 * Token routes on their way out. A personal API token with the `read` scope
 * used to reach every GET under these prefixes; the public API
 * (openapi/document.js) documents only some of them, and the token allowlist
 * (middleware/apiTokenAuth.js) now lists exactly those. The rest keep
 * answering tokens until SUNSET, announced as the stability promise says:
 *  - every such answer carries Deprecation (RFC 9745), Sunset (RFC 8594) and
 *    a Link to /developers;
 *  - every such use is counted per route and day (models/ApiDeprecatedUse),
 *    no user or token stored, so we know what would break;
 *  - /developers says so (openapi/guide.js).
 *
 * After SUNSET: delete DEPRECATED_RULES and what reads it — the routes then
 * answer tokens 403 like any other route outside the allowlist.
 */
const DEPRECATED_SINCE = new Date('2026-11-01T00:00:00Z');
const SUNSET = new Date('2027-05-01T00:00:00Z');

const DEPRECATED_RULES = {
  read: [
    { method: 'GET', pattern: /^\/api\/stats(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/cellars(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/bottles(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/notifications(\/|$)/ },
  ],
};

module.exports = { DEPRECATED_SINCE, SUNSET, DEPRECATED_RULES };
