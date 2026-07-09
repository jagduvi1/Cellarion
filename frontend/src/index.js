import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
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
