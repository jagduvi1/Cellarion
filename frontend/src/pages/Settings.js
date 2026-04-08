import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import useVersion from '../hooks/useVersion';
import { updateProfile } from '../api/profiles';
import { CURRENCIES } from '../config/currencies';
import { PLANS } from '../config/plans';
import { SCALE_META, VALID_SCALES } from '../utils/ratingUtils';
import { isPushSupported, getPushPermissionState, subscribeToPush, unsubscribeFromPush, getCurrentEndpoint, getDeviceStatus, sendTestPush } from '../utils/pushSubscription';
import { downloadBlobObject } from '../utils/downloadBlob';
import './Settings.css';

function Settings() {
  const { t, i18n } = useTranslation();
  const { user, apiFetch, updatePreferences, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const appVersion = useVersion();
  const [currency, setCurrency] = useState(user?.preferences?.currency || 'USD');
  const [language, setLanguage] = useState(user?.preferences?.language || i18n.language?.split('-')[0] || 'en');
  const [ratingScale, setRatingScale] = useState(user?.preferences?.ratingScale || '5');
  const [rackNavigation, setRackNavigation] = useState(user?.preferences?.rackNavigation || 'auto');
  const [restockScope, setRestockScope] = useState(user?.preferences?.restockScope || 'all');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // Profile state
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [profileVisibility, setProfileVisibility] = useState(user?.profileVisibility || 'public');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState(null);

  // Notification preferences state
  const notifPrefs = user?.preferences?.notifications || {};
  const [drinkWindow, setDrinkWindow] = useState(notifPrefs.drinkWindow !== false);
  const [emailNotif, setEmailNotif] = useState(notifPrefs.email === true);
  const [pushNotif, setPushNotif] = useState(notifPrefs.push === true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);
  const [notifError, setNotifError] = useState(null);
  const [vapidKey, setVapidKey] = useState(null);
  const pushSupported = isPushSupported();
  const pushDenied = getPushPermissionState() === 'denied';

  // Per-device push state
  const [currentEndpoint, setCurrentEndpoint] = useState(null);
  const [deviceStatus, setDeviceStatus] = useState({ totalDevices: 0, thisDeviceRegistered: false });
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Fetch VAPID key for push subscription
  const fetchVapidKey = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings');
      const data = await res.json();
      if (data.vapidPublicKey) setVapidKey(data.vapidPublicKey);
    } catch {}
  }, [apiFetch]);

  // Fetch current device push status
  const refreshDeviceStatus = useCallback(async () => {
    const ep = await getCurrentEndpoint();
    setCurrentEndpoint(ep);
    const status = await getDeviceStatus(apiFetch, ep);
    setDeviceStatus(status);
  }, [apiFetch]);

  useEffect(() => { fetchVapidKey(); }, [fetchVapidKey]);
  useEffect(() => { if (pushSupported) refreshDeviceStatus(); }, [pushSupported, refreshDeviceStatus]);

  const handleRegisterDevice = async () => {
    setDeviceLoading(true);
    setNotifError(null);
    const result = await subscribeToPush(apiFetch, vapidKey);
    if (!result.success) {
      setNotifError(result.error);
    } else {
      // Also enable master push toggle if it wasn't on
      if (!pushNotif) {
        setPushNotif(true);
        await updatePreferences({ notifications: { drinkWindow, email: emailNotif, push: true } });
      }
    }
    await refreshDeviceStatus();
    setDeviceLoading(false);
  };

  const handleRemoveDevice = async () => {
    setDeviceLoading(true);
    setNotifError(null);
    await unsubscribeFromPush(apiFetch);
    await refreshDeviceStatus();
    setDeviceLoading(false);
  };

  const handleTestPush = async () => {
    setTestSending(true);
    setTestResult(null);
    const ep = await getCurrentEndpoint();
    if (!ep) {
      setTestResult({ success: false, error: 'This device is not registered' });
      setTestSending(false);
      return;
    }
    const result = await sendTestPush(apiFetch, ep);
    setTestResult(result);
    if (!result.success && result.error?.includes('expired')) {
      await refreshDeviceStatus();
    }
    setTestSending(false);
    if (result.success) setTimeout(() => setTestResult(null), 5000);
  };

  const handleNotifSave = async () => {
    setNotifSaving(true);
    setNotifError(null);
    setNotifSaved(false);

    const result = await updatePreferences({
      notifications: { drinkWindow, email: emailNotif, push: pushNotif }
    });
    setNotifSaving(false);
    if (result.success) {
      setNotifSaved(true);
      setTimeout(() => setNotifSaved(false), 3000);
    } else {
      setNotifError(result.error);
    }
  };

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Data export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Deletion scheduled state
  const isDeletionScheduled = !!user?.deletionScheduledFor;
  const [cancelling, setCancelling] = useState(false);

  const handleProfileSave = async (e) => {
    e.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      const res = await updateProfile(apiFetch, { displayName: displayName || null, bio: bio || null, profileVisibility });
      const data = await res.json();
      if (res.ok) {
        setUser(data.user);
        setProfileSaved(true);
        setTimeout(() => setProfileSaved(false), 3000);
      } else {
        setProfileError(data.error || 'Failed to update profile');
      }
    } catch {
      setProfileError('Failed to update profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await updatePreferences({ currency, language, ratingScale, rackNavigation, restockScope });
    setSaving(false);
    if (result.success) {
      i18n.changeLanguage(language);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      setError(result.error);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiFetch('/api/users/me', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setUser({ ...user, deletionScheduledFor: data.deletionScheduledFor });
        setShowDeleteConfirm(false);
        setDeleteConfirmText('');
      } else {
        setDeleteError(data.error || 'Failed to schedule deletion');
      }
    } catch {
      setDeleteError('Failed to schedule deletion');
    } finally {
      setDeleting(false);
    }
  };

  const handleExportData = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await apiFetch('/api/users/me/export');
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      downloadBlobObject(blob, `cellarion-data-export-${user?.username || 'user'}.json`);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const handleCancelDeletion = async () => {
    setCancelling(true);
    try {
      const res = await apiFetch('/api/users/me/cancel-deletion', { method: 'POST' });
      if (res.ok) {
        setUser({ ...user, deletionScheduledFor: null, deletionRequestedAt: null });
      }
    } catch {
      // silent fail
    } finally {
      setCancelling(false);
    }
  };

  const planKey = user?.plan || 'free';
  const planExpiresAt = user?.planExpiresAt || null;
  const planLabel = PLANS[planKey]?.label || planKey;
  const planExpired = planExpiresAt && Date.now() > new Date(planExpiresAt).getTime();

  function formatExpiry(expiresAt) {
    if (!expiresAt) return t('settings.plan.noExpiry');
    if (Date.now() > new Date(expiresAt).getTime()) return t('plans.expired');
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>{t('settings.title')}</h1>
      </div>

      {/* ── Profile card ── */}
      <div className="card settings-card">
        <h2 className="settings-section-title">Profile</h2>
        <form onSubmit={handleProfileSave}>
          <div className="form-group">
            <label htmlFor="display-name-input">Display Name</label>
            <p className="settings-hint">
              How your name appears to other users. Leave blank to use your username.
            </p>
            <input
              id="display-name-input"
              type="text"
              className="input"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={user?.username || 'Display name'}
              maxLength={50}
            />
          </div>
          <div className="form-group">
            <label htmlFor="bio-input">Bio</label>
            <p className="settings-hint">
              A short description visible on your public profile.
            </p>
            <textarea
              id="bio-input"
              className="input"
              value={bio}
              onChange={e => setBio(e.target.value)}
              placeholder="Tell others about your wine journey..."
              maxLength={500}
              rows={3}
            />
          </div>

          <div className="form-group">
            <label htmlFor="visibility-select">Profile Visibility</label>
            <p className="settings-hint">
              Public profiles appear in search results and the Discover feed. Private profiles are hidden from other users.
            </p>
            <select
              id="visibility-select"
              className="input settings-select"
              value={profileVisibility}
              onChange={e => setProfileVisibility(e.target.value)}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>

          {profileError && <div className="alert alert-error">{profileError}</div>}

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={profileSaving}>
              {profileSaving ? t('settings.savingBtn') : t('settings.saveBtn')}
            </button>
            {profileSaved && <span className="settings-saved">{t('settings.savedMsg')}</span>}
          </div>
        </form>
      </div>

      {/* ── Your Supporter Tier card ── */}
      <div className="card settings-card settings-plan-card">
        <h2 className="settings-section-title">{t('settings.plan.title')}</h2>
        <div className="settings-plan-row">
          <span className={`settings-plan-badge settings-plan-badge--${planKey}`}>{planLabel}</span>
          <span className="settings-plan-desc">{PLANS[planKey]?.description}</span>
        </div>
        <p className="settings-hint">
          {planExpired
            ? <span className="settings-plan-expired">{t('supporter.expired')}</span>
            : <>{t('settings.plan.expires')} <strong>{formatExpiry(planExpiresAt)}</strong></>
          }
        </p>
        <Link to="/supporter" className="btn btn-secondary settings-plan-link">
          {t('settings.plan.comparePlans')}
        </Link>
      </div>

      {/* ── Notifications card ── */}
      <div className="card settings-card">
        <h2 className="settings-section-title">Notifications</h2>

        <div className="form-group">
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={drinkWindow}
              onChange={e => setDrinkWindow(e.target.checked)}
            />
            <span>Drink window alerts</span>
          </label>
          <p className="settings-hint">
            Get notified when bottles enter their peak, are nearing the end, or have passed their window.
          </p>
        </div>

        <div className="form-group">
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={emailNotif}
              onChange={e => setEmailNotif(e.target.checked)}
            />
            <span>Email notifications</span>
          </label>
          <p className="settings-hint">
            Receive a digest email when your bottles have drink-window updates.
          </p>
        </div>

        <div className="form-group">
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={pushNotif}
              onChange={e => setPushNotif(e.target.checked)}
              disabled={!pushSupported || (!vapidKey && !pushNotif) || pushDenied}
            />
            <span>Push notifications</span>
          </label>
          <p className="settings-hint">
            {!pushSupported
              ? 'Push notifications are not supported in this browser.'
              : pushDenied
                ? 'Push notifications are blocked. Please enable them in your browser settings.'
                : !vapidKey
                  ? 'Push notifications are not configured on this server.'
                  : 'Receive browser push notifications for all alerts — even when Cellarion is closed.'}
          </p>
        </div>

        {/* ── Per-device push management ── */}
        {pushSupported && vapidKey && !pushDenied && (
          <div className="settings-push-devices">
            <div className="settings-push-device-row">
              <span className={`settings-push-device-status ${deviceStatus.thisDeviceRegistered ? 'settings-push-device-status--active' : ''}`}>
                {deviceStatus.thisDeviceRegistered ? 'This device is registered' : 'This device is not registered'}
              </span>
              {deviceStatus.thisDeviceRegistered ? (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleRemoveDevice}
                  disabled={deviceLoading}
                >
                  {deviceLoading ? 'Removing...' : 'Remove this device'}
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleRegisterDevice}
                  disabled={deviceLoading}
                >
                  {deviceLoading ? 'Registering...' : 'Register this device'}
                </button>
              )}
            </div>
            {deviceStatus.totalDevices > 0 && (
              <p className="settings-hint" style={{ marginTop: '0.25rem' }}>
                {deviceStatus.totalDevices} {deviceStatus.totalDevices === 1 ? 'device' : 'devices'} registered for push notifications.
              </p>
            )}
            {deviceStatus.thisDeviceRegistered && (
              <div className="settings-push-test-row">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleTestPush}
                  disabled={testSending}
                >
                  {testSending ? 'Sending...' : 'Send test notification'}
                </button>
                {testResult && (
                  <span className={testResult.success ? 'settings-saved' : 'settings-push-test-error'}>
                    {testResult.success ? 'Test sent!' : testResult.error}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {notifError && <div className="alert alert-error">{notifError}</div>}

        <div className="settings-actions">
          <button className="btn btn-primary" onClick={handleNotifSave} disabled={notifSaving}>
            {notifSaving ? t('settings.savingBtn') : t('settings.saveBtn')}
          </button>
          {notifSaved && <span className="settings-saved">{t('settings.savedMsg')}</span>}
        </div>
      </div>

      <div className="card settings-card">
        <h2 className="settings-section-title">{t('settings.displayPreferences')}</h2>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="currency-select">{t('settings.defaultCurrency')}</label>
            <p className="settings-hint">
              {t('settings.currencyHint')}
            </p>
            <select
              id="currency-select"
              className="input settings-select"
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              {CURRENCIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="language-select">{t('settings.language')}</label>
            <p className="settings-hint">
              {t('settings.languageHint')}
            </p>
            <select
              id="language-select"
              className="input settings-select"
              value={language}
              onChange={e => setLanguage(e.target.value)}
            >
              <option value="en">{t('settings.languageEn')}</option>
              <option value="sv">{t('settings.languageSv')}</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="rating-scale-select">{t('settings.defaultRatingScale', 'Default Rating Scale')}</label>
            <p className="settings-hint">
              {t('settings.ratingScaleHint', 'Choose which rating scale to use by default when adding ratings. You can always override per bottle.')}
            </p>
            <select
              id="rating-scale-select"
              className="input settings-select"
              value={ratingScale}
              onChange={e => setRatingScale(e.target.value)}
            >
              {VALID_SCALES.map(s => (
                <option key={s} value={s}>
                  {SCALE_META[s].label} ({SCALE_META[s].min}–{SCALE_META[s].max}{SCALE_META[s].suffix})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="rack-nav-select">{t('settings.rackNavigation', 'Rack Navigation')}</label>
            <p className="settings-hint">
              {t('settings.rackNavigationHint', 'Choose where rack links take you. Auto uses 3D room on large screens and flat rack view on mobile.')}
            </p>
            <select
              id="rack-nav-select"
              className="input settings-select"
              value={rackNavigation}
              onChange={e => setRackNavigation(e.target.value)}
            >
              <option value="auto">{t('settings.rackNavAuto', 'Auto (desktop: 3D room, mobile: rack)')}</option>
              <option value="room">{t('settings.rackNavRoom', 'Always 3D room')}</option>
              <option value="rack">{t('settings.rackNavRack', 'Always flat rack')}</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="restock-scope-select">{t('settings.restockScope', 'Restock Alert Scope')}</label>
            <p className="settings-hint">
              {t('settings.restockScopeHint', 'When checking if you have similar wines after consuming a bottle, should we check all your cellars or only the one the bottle came from?')}
            </p>
            <select
              id="restock-scope-select"
              className="input settings-select"
              value={restockScope}
              onChange={e => setRestockScope(e.target.value)}
            >
              <option value="all">{t('settings.restockScopeAll', 'All cellars (default)')}</option>
              <option value="cellar">{t('settings.restockScopeCellar', 'Same cellar only')}</option>
            </select>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('settings.savingBtn') : t('settings.saveBtn')}
            </button>
            {saved && <span className="settings-saved">{t('settings.savedMsg')}</span>}
          </div>
        </form>
      </div>

      {/* ── Your Data (GDPR) ── */}
      <div className="card settings-card">
        <h2 className="settings-section-title">Your Data</h2>
        <p className="settings-hint">
          Download a complete copy of all your personal data stored in Cellarion, including
          your profile, bottles, cellars, reviews, and activity log.
        </p>
        <button
          className="btn btn-secondary"
          onClick={handleExportData}
          disabled={exporting}
        >
          {exporting ? 'Exporting...' : 'Export my data'}
        </button>
        {exportError && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{exportError}</div>}
        <p className="settings-hint" style={{ marginTop: '1rem' }}>
          Read our <a href="/privacy">Privacy Policy</a> to learn how your data is processed and what rights you have.
        </p>
      </div>

      {/* ── Danger zone ── */}
      <div className="card settings-card settings-danger-card">
        <h2 className="settings-section-title settings-danger-title">Danger zone</h2>
        {isDeletionScheduled ? (
          <div>
            <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
              Account deletion is scheduled for{' '}
              <strong>{new Date(user.deletionScheduledFor).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>.
              All your data will be permanently removed after this date.
            </div>
            <button
              className="btn btn-secondary"
              onClick={handleCancelDeletion}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling...' : 'Cancel deletion'}
            </button>
          </div>
        ) : (
          <>
            <p className="settings-hint">
              Permanently delete your account and all associated data — cellars, bottles, reviews, and settings.
              After requesting deletion, you have 7 days to change your mind before the deletion is permanent.
            </p>
            {!showDeleteConfirm ? (
              <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
                Delete my account
              </button>
            ) : (
              <div className="settings-delete-confirm">
                <p>Type <strong>DELETE</strong> to confirm:</p>
                <input
                  type="text"
                  className="input"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder="DELETE"
                  autoFocus
                />
                {deleteError && <div className="alert alert-error">{deleteError}</div>}
                <div className="settings-actions">
                  <button
                    className="btn btn-danger"
                    onClick={handleDeleteAccount}
                    disabled={deleteConfirmText !== 'DELETE' || deleting}
                  >
                    {deleting ? 'Scheduling...' : 'Schedule account deletion'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(''); }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {appVersion && (
        <p className="settings-version">Cellarion v{appVersion}</p>
      )}
    </div>
  );
}

export default Settings;
