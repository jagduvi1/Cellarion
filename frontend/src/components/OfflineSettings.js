import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  OFFLINE_MODE_RELEASED, isOfflineModeEnabled, isStandaloneApp, setOfflineModePreference,
} from '../utils/offlineMode';
import { getOfflineStatus, subscribeOfflineStatus, clearOfflineData, refreshSnapshot } from '../utils/offlineSnapshot';
import { getQueueStatus, subscribeQueueStatus } from '../utils/offlineQueue';

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings → Offline mode (#1355). Until offline mode is released it is shown
 * to admins only, so it can be tried on a real phone against production while
 * nobody else sees it.
 */
export default function OfflineSettings() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [enabled, setEnabled] = useState(isOfflineModeEnabled);
  const [status, setStatus] = useState(getOfflineStatus);
  const [queue, setQueue] = useState(getQueueStatus);
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState(null); // 'enabling' | 'clearing' | null
  const [message, setMessage] = useState(null);

  useEffect(() => subscribeOfflineStatus(setStatus), []);
  useEffect(() => subscribeQueueStatus(setQueue), []);
  useEffect(() => {
    let alive = true;
    navigator.storage?.estimate?.().then((e) => { if (alive) setUsage(e?.usage ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [status.savedAt, enabled]);

  const isAdmin = (user?.roles || []).includes('admin');
  if (!OFFLINE_MODE_RELEASED && !isAdmin) return null;

  const userId = user ? String(user.id || user._id) : null;
  const waiting = queue.pending + queue.attention;

  const turnOn = async () => {
    setBusy('enabling');
    setMessage(null);
    try {
      // The app download (service worker) runs in the background; the cellar
      // copy doesn't wait for it.
      setOfflineModePreference('on');
      setEnabled(true);
      try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
      const ok = await refreshSnapshot(apiFetch, userId);
      setMessage(ok
        ? t('offline.settings.ready', 'Ready — your cellar is saved on this device.')
        : t('offline.settings.notYet', 'Turned on. Your cellar will be saved the next time you are online.'));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (waiting > 0 && !window.confirm(t('offline.logoutConfirm', { count: waiting }))) return;
    setBusy('clearing');
    try {
      await setOfflineModePreference('off');
      await clearOfflineData();
      setEnabled(false);
      setMessage(t('offline.settings.cleared', 'Turned off. The offline copy has been deleted from this device.'));
    } finally {
      setBusy(null);
    }
  };

  const savedAt = status.savedAt ? new Date(status.savedAt).toLocaleString() : null;

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">
        {t('offline.settings.title', 'Offline mode')}
        {!OFFLINE_MODE_RELEASED && <span className="settings-hint" style={{ marginLeft: '0.5rem' }}>{t('offline.settings.betaAdmin', '(beta — admins only)')}</span>}
      </h2>
      <p className="settings-hint">
        {t('offline.settings.intro', 'Keep a copy of your cellars, racks and bottles on this device, so you can browse them — and consume, open, place or move bottles — where there is no signal. Changes are sent when you are back online.')}
      </p>
      <p className="settings-hint">
        {isStandaloneApp()
          ? t('offline.settings.appHint', 'You are using the installed app.')
          : t('offline.settings.browserHint', 'On a shared or borrowed computer, leave this off: the copy stays on the device until you log out or turn it off.')}
      </p>

      <label className="settings-toggle" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.75rem 0' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!!busy}
          onChange={(e) => (e.target.checked ? turnOn() : turnOff())}
        />
        <span>{t('offline.settings.toggle', 'Keep my cellar available offline on this device')}</span>
      </label>

      {busy === 'enabling' && <p className="settings-hint">{t('offline.settings.saving', 'Saving your cellar on this device…')}</p>}
      {message && <p className="settings-hint">{message}</p>}

      {enabled && (
        <ul className="settings-hint" style={{ margin: '0.5rem 0 0.75rem', paddingLeft: '1.1rem' }}>
          <li>{savedAt ? t('offline.settings.savedAt', 'Saved: {{time}}', { time: savedAt }) : t('offline.settings.notSaved', 'Not saved yet')}</li>
          {usage != null && <li>{t('offline.settings.usage', 'Space used on this device: {{size}}', { size: formatBytes(usage) })}</li>}
          {waiting > 0 && <li>{t('offline.pending', { count: queue.pending })}{queue.attention > 0 ? ` · ${t('offline.attention', { count: queue.attention })}` : ''}</li>}
        </ul>
      )}
    </div>
  );
}
