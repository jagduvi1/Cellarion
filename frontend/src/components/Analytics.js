import { Helmet } from 'react-helmet-async';

// Self-hosted Umami tracker. Mounted at app root (App.js) so the script loads once
// per session and Umami's built-in History API listener handles SPA route changes.
//
// Configured via build-time env vars:
//   REACT_APP_UMAMI_URL          e.g. https://analytics.cellarion.app
//   REACT_APP_UMAMI_WEBSITE_ID   uuid from the Umami dashboard
//
// If either is missing (e.g. local dev without analytics) the script isn't injected
// and the component is a no-op. No CSP changes needed for that case.
export default function Analytics() {
  const url = process.env.REACT_APP_UMAMI_URL;
  const websiteId = process.env.REACT_APP_UMAMI_WEBSITE_ID;

  if (!url || !websiteId) return null;

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
