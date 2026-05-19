import { Helmet } from 'react-helmet-async';

// Self-hosted Umami tracker. Mounted at app root (App.js) so the script loads once
// per session and Umami's built-in History API listener handles SPA route changes.
//
// Configured via build-time env vars:
//   VITE_UMAMI_URL          e.g. https://analytics.cellarion.app
//   VITE_UMAMI_WEBSITE_ID   uuid from the Umami dashboard
//
// If either is missing the script isn't injected — analytics is fully opt-in.
//
// Hostname guard: the vars are baked into the GHCR image, so without this check
// self-hosters running that image on their own domain would send their traffic to
// cellarion.app's Umami. We derive the expected hostname from the URL var and
// compare at runtime — if they don't match, no script is injected.
//
// Route exclusions: admin, superadmin, and settings paths are excluded. They contain
// no useful SEO/marketing data and recording them pollutes the dashboard with noise.
// Note: Umami fires before React's ProtectedRoute can redirect, so a non-admin who
// visits /admin/* would otherwise be recorded even though they never see the content.

const EXCLUDED_PREFIXES = [
  '/admin',
  '/superadmin',
  '/settings',
  '/cellars',
  '/users',
];

export default function Analytics() {
  const url = import.meta.env.VITE_UMAMI_URL;
  const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;

  if (!url || !websiteId) return null;

  // Hostname guard — compare the base domain (eTLD+1) of the Umami URL against
  // the current page domain. This ensures the tracker only fires when the site
  // is running on the same root domain as the analytics instance.
  //
  // Example: VITE_UMAMI_URL = "https://analytics.cellarion.app"
  //   → baseDomain = "cellarion.app"
  //   → only fires when window.location.hostname ends with "cellarion.app"
  //   → self-hosters on "their-domain.com" are excluded automatically
  try {
    const getBase = (hostname) => {
      const parts = hostname.replace(/^www\./, '').split('.');
      return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
    };
    const expectedBase = getBase(new URL(url).hostname);
    const currentBase = getBase(window.location.hostname);
    if (currentBase !== expectedBase) return null;
  } catch {
    return null;
  }

  const path = window.location.pathname;
  if (EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return null;

  return (
    <Helmet>
      <script
        async
        defer
        src={`${url.replace(/\/$/, '')}/script.js`}
        data-website-id={websiteId}
      />
    </Helmet>
  );
}
