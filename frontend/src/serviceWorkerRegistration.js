const isLocalhost = Boolean(
  window.location.hostname === 'localhost' ||
  window.location.hostname === '[::1]' ||
  /^127(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(window.location.hostname)
);

export function register() {
  if ('serviceWorker' in navigator) {
    const publicUrl = new URL(process.env.PUBLIC_URL, window.location.href);
    if (publicUrl.origin !== window.location.origin) return;

    window.addEventListener('load', () => {
      const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`;

      if (isLocalhost) {
        // In localhost, check if the SW still exists before registering
        checkValidServiceWorker(swUrl);
      } else {
        registerValidSW(swUrl);
      }
    });
  }
}

function registerValidSW(swUrl) {
  navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      registration.onupdatefound = () => {
        const installingWorker = registration.installing;
        if (!installingWorker) return;

        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // New content available — will be used on next visit
              console.log('Cellarion: new version available. Refresh to update.');
            } else {
              console.log('Cellarion: app cached for offline use.');
            }
          }
        };
      };
    })
    .catch((error) => {
      console.error('Error during service worker registration:', error);
    });
}

function checkValidServiceWorker(swUrl) {
  fetch(swUrl, { headers: { 'Service-Worker': 'script' } })
    .then((response) => {
      const contentType = response.headers.get('content-type');
      if (response.status === 404 || (contentType && !contentType.includes('javascript'))) {
        navigator.serviceWorker.ready.then((registration) => {
          registration.unregister().then(() => window.location.reload());
        });
      } else {
        registerValidSW(swUrl);
      }
    })
    .catch(() => {
      console.log('No internet connection. App is running in offline mode.');
    });
}

export function unregister() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => registration.unregister())
      .catch((error) => console.error(error));
  }
}
