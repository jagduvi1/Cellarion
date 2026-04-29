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
// IMPORTANT — hostname guard: these vars are baked into the pre-built GHCR image,
// so without this check self-hosters running that image on their own domain would
// send their users' data to cellarion.app's Umami. The guard ensures the tracker
// only fires on the domain the URL var points to.
export default function Analytics() {
  const url = process.env.REACT_APP_UMAMI_URL;
  const websiteId = process.env.REACT_APP_UMAMI_WEBSITE_ID;

  if (!url || !websiteId) return null;

  // Derive the expected hostname from the configured URL and compare it to the
  // current page hostname at runtime. This works even after the vars are baked in.
  try {
    const expectedHost = new URL(url).hostname
      .replace(/^www\./, '');
    const currentHost = window.location.hostname
      .replace(/^www\./, '');
    if (currentHost !== expectedHost) return null;
  } catch {
    return null;
  }

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
