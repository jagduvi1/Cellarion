import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// Fonts ship with the app (audit 2026-09 F03-4): no request to Google Fonts
// leaves the visitor's browser. Weights match what index.css asks for.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/700.css';
import './i18n';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

// A page's code file that no longer exists: this tab is on a build that a
// deploy has replaced (and, offline, the stored app is now the new build).
// Reload once onto the current build instead of showing a broken page. The
// sessionStorage stamp keeps a genuinely missing file from reloading forever.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('cellarion-chunk-reload') || 0);
    if (Date.now() - last < 30000) return;
    sessionStorage.setItem('cellarion-chunk-reload', String(Date.now()));
  } catch { /* storage blocked: reload anyway, once per page */ }
  event.preventDefault();
  window.location.reload();
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Remove static pre-boot elements once React has painted
requestAnimationFrame(() => {
  document.getElementById('preboot-logo')?.remove();
  document.getElementById('preboot-heading')?.remove();
});

// Register the service worker for PWA support (offline caching + installability)
serviceWorkerRegistration.register();
