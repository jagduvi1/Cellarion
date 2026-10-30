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
 *  - the token that made it is marked with its own use (ApiToken.deprecatedUse:
 *    the route keys, first and last seen), because the counts cannot say whom
 *    to tell and headers reach only developers who read them. Its owner — the
 *    one person whose integration would break — is told in the app and by
 *    email on the first such call and again before SUNSET while the token
 *    still calls them, and sees it on the token in Settings → API tokens
 *    (services/apiDeprecationNotices). The marker is the owner's data about
 *    their own token: exported and deleted with it;
 *  - /developers says so (openapi/guide.js).
 *
 * From SUNSET on, middleware/apiTokenAuth refuses them by itself (403, like
 * any route outside the allowlist), also on a server that is never updated,
 * and the daily notice job clears the token markers, which mean nothing any
 * more. Deleting DEPRECATED_RULES and what reads it afterwards is cleanup;
 * the notice machinery reads only SUNSET and the rules, so it serves the next
 * deprecation as it stands.
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
