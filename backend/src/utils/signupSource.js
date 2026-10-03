/**
 * Where a new account came from — "Reddit", "a Google search", "a shared wine
 * list" — recorded once at signup so the admin stats page can show which
 * channels bring people who stay, not only people who visit.
 *
 * The browser captures it in memory on the landing page (frontend
 * utils/signupSource.js) and sends it with the registration. It is a coarse,
 * allow-listed shape on purpose (data minimisation):
 *
 *   referrerDomain — the referring site's hostname only, never the full URL
 *   utmSource / utmMedium / utmCampaign — campaign tags from the landing link
 *   landingPage   — the FIRST path segment only ("/menu", not "/menu/<token>"):
 *                   some public paths carry a token that must not be copied
 *                   onto an account
 *
 * Anything else in the payload is dropped, and every value is length-capped
 * and restricted to a narrow character set so the field cannot be used as
 * free-form storage.
 */

const MAX_LEN = 100;

const DOMAIN_RE = /^[a-z0-9.-]+$/;
const TAG_RE = /^[a-z0-9._ -]+$/;
const LANDING_RE = /^\/[a-z0-9-]*$/;

function cleanString(value, re) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase().slice(0, MAX_LEN);
  return v && re.test(v) ? v : undefined;
}

/**
 * Reduce a client-supplied payload to the allow-listed fields. Returns null
 * when the input is not an object; an object with no usable fields comes back
 * as {} (a "direct" visit — still worth recording).
 */
function sanitizeSignupSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const referrerDomain = cleanString(raw.referrerDomain, DOMAIN_RE);
  const utmSource = cleanString(raw.utmSource, TAG_RE);
  const utmMedium = cleanString(raw.utmMedium, TAG_RE);
  const utmCampaign = cleanString(raw.utmCampaign, TAG_RE);
  const landingPage = cleanString(raw.landingPage, LANDING_RE);
  if (referrerDomain) out.referrerDomain = referrerDomain.replace(/^www\./, '');
  if (utmSource) out.utmSource = utmSource;
  if (utmMedium) out.utmMedium = utmMedium;
  if (utmCampaign) out.utmCampaign = utmCampaign;
  if (landingPage) out.landingPage = landingPage;
  return out;
}

// Referrer hostnames grouped into the channels the stats page reports. Matched
// as the hostname itself or any subdomain of it ("old.reddit.com" → reddit).
const CHANNEL_DOMAINS = [
  ['ai-assistant', ['chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'perplexity.ai',
    'gemini.google.com', 'copilot.microsoft.com', 'you.com', 'phind.com']],
  ['reddit', ['reddit.com']],
  ['search', ['google.com', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'search.yahoo.com',
    'yahoo.com', 'startpage.com', 'qwant.com', 'search.brave.com', 'yandex.com', 'baidu.com']],
  ['social', ['facebook.com', 'instagram.com', 't.co', 'x.com', 'twitter.com', 'linkedin.com',
    'lnkd.in', 'threads.net', 'bsky.app', 'mastodon.social', 'youtube.com', 'tiktok.com', 'pinterest.com']],
  ['github', ['github.com']],
  ['hacker-news', ['news.ycombinator.com']],
  ['product-hunt', ['producthunt.com']],
];

const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Google and other search engines also serve country domains (google.se,
// google.co.uk) — catch those by their first label.
const SEARCH_PREFIXES = ['google.', 'bing.', 'yahoo.', 'yandex.'];

// The channel a hostname belongs to, or null when it is not a known one.
function channelForHost(host) {
  for (const [channel, domains] of CHANNEL_DOMAINS) {
    if (domains.some((d) => matchesDomain(host, d))) return channel;
  }
  if (SEARCH_PREFIXES.some((p) => host.startsWith(p) || host.includes(`.${p}`))) return 'search';
  return null;
}

/**
 * One channel label for a recorded source. Precedence: a shared wine list
 * (the landing page says so even when the link had no tags) → an explicit
 * utm_source → the referrer's channel → "direct".
 *
 * A utm_source that is itself a known site is filed under that site's
 * channel: ChatGPT, for one, tags the links it hands out with
 * utm_source=chatgpt.com, which belongs with the other AI assistants.
 *
 * `null` (an account created before sources were recorded) → 'unknown'.
 */
function classifySignupSource(src) {
  if (!src) return 'unknown';
  if (src.landingPage === '/menu') return 'shared-list';
  if (src.utmSource) return channelForHost(src.utmSource) || src.utmSource;
  const host = src.referrerDomain;
  if (!host) return 'direct';
  return channelForHost(host) || 'other-site';
}

module.exports = { sanitizeSignupSource, classifySignupSource, MAX_LEN };
