/**
 * Where this visit came from — the referring site and any campaign tags on the
 * landing link — so a signup can record its channel for the admin stats
 * ("signups by source"). The backend allow-lists the same shape again
 * (backend/src/utils/signupSource.js); this side only collects it.
 *
 * Captured once, from the page the visitor LANDED on, and held in memory: not
 * a cookie, not localStorage. A visitor who leaves and comes back later is a
 * new landing. The one exception is the single sign-on round trip, which
 * leaves the page; see stashSignupSourceForSso below.
 *
 * Minimised on purpose: the referrer is reduced to its hostname, and the
 * landing page to its first path segment ("/menu", never "/menu/<token>").
 */

const MAX_LEN = 100;
const SSO_STASH_KEY = 'cellarion.signupSource';

let landing = null;

// The registrable part of a hostname, crudely: the last two labels. Good enough
// to treat analytics.cellarion.app and cellarion.app as the same site.
const baseDomain = (host) => host.replace(/^www\./, '').split('.').slice(-2).join('.');

function tag(params, key) {
  const v = params.get(key);
  return v ? v.trim().toLowerCase().slice(0, MAX_LEN) : undefined;
}

/**
 * Read the landing context. Idempotent: the first call wins, so calling it at
 * startup and again later (after in-app navigation) still reports the landing.
 */
export function captureSignupSource(loc = window.location, referrer = document.referrer) {
  if (landing) return landing;
  const params = new URLSearchParams(loc.search || '');
  let referrerDomain;
  try {
    if (referrer) {
      const host = new URL(referrer).hostname.toLowerCase();
      // A link from our own site is not a source.
      if (host && baseDomain(host) !== baseDomain(loc.hostname.toLowerCase())) {
        referrerDomain = host.replace(/^www\./, '').slice(0, MAX_LEN);
      }
    }
  } catch { /* unparsable referrer: treat as none */ }
  const firstSegment = (loc.pathname || '/').split('/')[1] || '';
  landing = {
    referrerDomain,
    utmSource: tag(params, 'utm_source'),
    utmMedium: tag(params, 'utm_medium'),
    utmCampaign: tag(params, 'utm_campaign'),
    landingPage: `/${firstSegment.toLowerCase()}`.slice(0, MAX_LEN),
  };
  return landing;
}

/** The landing context, without undefined fields — ready for a request body. */
export function getSignupSource() {
  const src = landing || captureSignupSource();
  return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined));
}

/**
 * Single sign-on leaves the page for the provider and comes back as a fresh
 * page load, which would lose the in-memory landing. Carry it across that one
 * trip in sessionStorage (this tab only) — the same way the post-login
 * destination travels (utils/postLoginRedirect.js) — and take it back on
 * return. Written only when the visitor clicks an SSO button.
 */
export function stashSignupSourceForSso() {
  try { sessionStorage.setItem(SSO_STASH_KEY, JSON.stringify(getSignupSource())); } catch { /* storage blocked */ }
}

/** Single-use: returns the stashed source (or null) and removes it. */
export function takeSsoSignupSource() {
  try {
    const raw = sessionStorage.getItem(SSO_STASH_KEY);
    sessionStorage.removeItem(SSO_STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Tests only: forget the captured landing. */
export function __resetSignupSourceForTests() { landing = null; }
