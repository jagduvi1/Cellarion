/**
 * A wishlist entry's shop link, as the server stores it.
 *
 * Members paste a shop's page for a wine they want to buy later. The link is
 * trimmed, and https:// is added when the scheme was left off
 * ("shop.example/wine"). Only http and https are accepted, so a stored link
 * can never run script when the wishlist renders it as a link.
 *
 * Returns { url } (the normalised address), { url: null } for an empty value
 * (no link, or clear the link), or { error: true } for anything else.
 */
const SHOP_URL_MAX_LENGTH = 2000;

function normalizeShopUrl(raw) {
  if (raw == null) return { url: null };
  if (typeof raw !== 'string') return { error: true };
  const trimmed = raw.trim();
  if (!trimmed) return { url: null };
  if (trimmed.length > SHOP_URL_MAX_LENGTH) return { error: true };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: true };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: true };
  // A shop is on the public web: a bare host ("https://localhost") is a typo.
  if (!parsed.hostname.includes('.')) return { error: true };
  if (parsed.href.length > SHOP_URL_MAX_LENGTH) return { error: true };
  return { url: parsed.href };
}

module.exports = { normalizeShopUrl, SHOP_URL_MAX_LENGTH };
