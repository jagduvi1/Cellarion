import { Helmet } from 'react-helmet-async';

// Self-hosted Umami tracker. Mounted at app root (App.js) so the script loads once
// per session and Umami's built-in History API listener handles SPA route changes.
//
// Configured via build-time env vars:
//   REACT_APP_UMAMI_URL          e.g. https://analytics.cellarion.app
//   REACT_APP_UMAMI_WEBSITE_ID   uuid from the Umami dashboard
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
  const url = process.env.REACT_APP_UMAMI_URL;
  const websiteId = process.env.REACT_APP_UMAMI_WEBSITE_ID;

  if (!url || !websiteId) return null;

  // Hostname guard
  try {
    const expectedHost = new URL(url).hostname.replace(/^www\./, '');
    const currentHost = window.location.hostname.replace(/^www\./, '');
    if (currentHost !== expectedHost) return null;
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
