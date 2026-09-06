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
