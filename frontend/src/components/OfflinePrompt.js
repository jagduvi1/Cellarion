import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import { needsOfflineChoice, setOfflineModePreference, OFFLINE_MODE_EVENT } from '../utils/offlineMode';
import { refreshSnapshot } from '../utils/offlineSnapshot';

/**
 * The installed app asks once, after sign-in, whether to keep the cellar on
 * the phone for offline use (#1355). Nothing is stored on the device before a
 * yes; the answer is kept and never asked again (Settings → Offline mode
 * changes it). A browser tab never asks — there it is only switched on in
 * Settings.
 */
export default function OfflinePrompt() {
  const { t } = useTranslation();
  const { user, offlineSession, apiFetch } = useAuth();
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMode = () => setTick((n) => n + 1);
    window.addEventListener(OFFLINE_MODE_EVENT, onMode);
    return () => window.removeEventListener(OFFLINE_MODE_EVENT, onMode);
  }, []);

  // After the privacy-policy acknowledgement, never on top of it.
  if (!user || offlineSession || user.isDemo || user.requiresPolicyReconsent || !needsOfflineChoice()) return null;

  const choose = async (on) => {
    setBusy(true);
    try {
      setOfflineModePreference(on ? 'on' : 'off');
      if (on) {
        try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
        refreshSnapshot(apiFetch, String(user.id || user._id)).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('offline.prompt.title', 'Use Cellarion without a signal?')} onClose={() => choose(false)}>
      <p>{t('offline.prompt.body', 'Keep a copy of your cellars, racks and bottles on this phone, so you can browse them — and take out, open or move bottles — where there is no signal. Changes are sent when you are back online.')}</p>
      <p className="settings-hint">{t('offline.prompt.where', 'The copy stays on this phone only and is deleted when you log out. You can change this any time in Settings → Offline mode.')}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => choose(false)}>
          {t('offline.prompt.no', 'No thanks')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => choose(true)}>
          {t('offline.prompt.yes', 'Yes, keep it offline')}
        </button>
      </div>
    </Modal>
  );
}
