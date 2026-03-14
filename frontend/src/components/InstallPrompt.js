import { useState, useEffect } from 'react';

function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Don't show if user previously dismissed
    if (sessionStorage.getItem('pwa-install-dismissed')) {
      setDismissed(true);
      return;
    }

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    setDeferredPrompt(null);
    sessionStorage.setItem('pwa-install-dismissed', '1');
  };

  if (!deferredPrompt || dismissed) return null;

  return (
    <div className="install-prompt">
      <span className="install-prompt-text">
        Install Cellarion for quick access
      </span>
      <div className="install-prompt-actions">
        <button className="btn btn-primary btn-sm" onClick={handleInstall}>
          Install
        </button>
        <button className="install-prompt-dismiss" onClick={handleDismiss} aria-label="Dismiss">
          &times;
        </button>
      </div>
    </div>
  );
}

export default InstallPrompt;
