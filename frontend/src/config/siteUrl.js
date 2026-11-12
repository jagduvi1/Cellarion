/**
 * The address this install is reached at: share links, canonical and og:url
 * tags and the JSON-LD on public pages are built from it.
 *
 * It is the address in the browser, so a self-hosted install names itself and
 * the hosted site names cellarion.app, from the same published image. A build
 * can pin another address with VITE_SITE_URL. The backend's twin is
 * utils/siteUrl.js (siteBaseUrl), which reads FRONTEND_URL.
 *
 * A link that must reach the hosted site whatever the install is uses
 * HOSTED_ORIGIN from utils/mcpConnect instead.
 */
import { HOSTED_ORIGIN } from '../utils/mcpConnect';

export function resolveSiteUrl(pinned, location) {
  const origin = location && location.origin;
  // 'null' is what a page without a real origin (a file, a sandbox) reports.
  const fromBrowser = origin && origin !== 'null' ? origin : '';
  return (pinned || fromBrowser || HOSTED_ORIGIN).replace(/\/+$/, '');
}

const SITE_URL = resolveSiteUrl(
  import.meta.env.VITE_SITE_URL,
  typeof window !== 'undefined' ? window.location : undefined,
);

export default SITE_URL;
