import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import SetPasswordNotice from './SetPasswordNotice';
import { listBridgeKeys, createBridgeKey, revokeBridgeKey, openBridgeImportWindow } from '../api/bridge';

// Registry Bridge keys (Settings card). A self-hosted Cellarion presents one of
// these to cellarion.app to search the shared registry and copy single wines
// into its own database. Create (terms + password-confirmed, plaintext shown
// once with the two .env lines), list with today's usage, open the monthly
// import window, revoke. Same shape as ApiTokensSection on purpose.
function SelfHostedBridgeSection() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();

  const [keys, setKeys] = useState([]);
  const [revoked, setRevoked] = useState([]); // admin revocations of the last 30 days, with the reason
  const [maxActive, setMaxActive] = useState(2);
  const [terms, setTerms] = useState({ version: null, accepted: false, url: '/terms' });
  const [listError, setListError] = useState(null);

  // Create flow
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState(null); // { key, env } — plaintext, shown exactly once
  const [copied, setCopied] = useState(false);

  // Revoke + import window
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [windowBusy, setWindowBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await listBridgeKeys(apiFetch);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setKeys(data.keys || []);
      setRevoked(data.revoked || []);
      setMaxActive(data.maxActive || 2);
      setTerms(data.terms || { version: null, accepted: false, url: '/terms' });
      setListError(null);
    } catch {
      setListError(t('settings.bridge.errorLoad', 'Failed to load bridge keys.'));
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  const closeCreate = () => {
    setShowCreate(false);
    setName('');
    setAcceptTerms(false);
    setPassword('');
    setCreateError(null);
    setCreated(null);
    setCopied(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!terms.accepted && !acceptTerms) {
      setCreateError(t('settings.bridge.errorTerms', 'Accept the Registry Data Terms to create a key.'));
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createBridgeKey(apiFetch, { name: name.trim(), password, acceptTerms: terms.accepted || acceptTerms });
      if (res.status === 403) {
        setCreateError(t('settings.bridge.errorWrongPassword', 'Your password is incorrect.'));
      } else if (res.status === 429) {
        setCreateError(t('settings.bridge.errorRateLimited', 'Too many attempts. Please wait a few minutes and try again.'));
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error || t('settings.bridge.errorGeneric', 'Something went wrong. Please try again.'));
      } else {
        const data = await res.json();
        setCreated({ key: data.key, env: data.env });
        setPassword('');
        await load();
      }
    } catch {
      setCreateError(t('settings.bridge.errorGeneric', 'Something went wrong. Please try again.'));
    } finally {
      setCreating(false);
    }
  };

  const envText = created ? `REGISTRY_BRIDGE_URL=${created.env?.REGISTRY_BRIDGE_URL || ''}\nREGISTRY_BRIDGE_KEY=${created.key}` : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(envText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await revokeBridgeKey(apiFetch, revokeTarget.id);
      if (!res.ok) throw new Error();
      setRevokeTarget(null);
      await load();
    } catch {
      setListError(t('settings.bridge.errorGeneric', 'Something went wrong. Please try again.'));
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  };

  const handleImportWindow = async (key) => {
    setWindowBusy(key.id);
    setNotice(null);
    try {
      const res = await openBridgeImportWindow(apiFetch, key.id);
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setNotice(t('settings.bridge.windowCooldown', 'An import window was opened for this key less than 30 days ago.'));
      } else if (!res.ok) {
        setNotice(data.error || t('settings.bridge.errorGeneric', 'Something went wrong. Please try again.'));
      } else {
        setNotice(t('settings.bridge.windowOpened', 'Import window open for 24 hours: this key can fetch five times its daily quota.'));
        await load();
      }
    } catch {
      setNotice(t('settings.bridge.errorGeneric', 'Something went wrong. Please try again.'));
    } finally {
      setWindowBusy(null);
    }
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString() : null;
  const usageLine = (k) => {
    const u = k.usage?.used || {}; const c = k.usage?.caps || {};
    return t('settings.bridge.usage', 'Today: {{searches}}/{{searchCap}} searches · {{fetches}}/{{fetchCap}} wines', {
      searches: u.searches || 0, searchCap: c.searches || 0, fetches: u.fetches || 0, fetchCap: c.fetches || 0,
    });
  };

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">{t('settings.bridge.title', 'Connect a self-hosted Cellarion')}</h2>
      <p className="settings-hint">
        {t('settings.bridge.hint', 'A bridge key lets your own Cellarion server search the shared wine registry and copy the wines you add into its database, one wine at a time. Keys are tied to your account, count against daily quotas, and can be revoked here. The key is shown only once.')}
        {' '}
        <Link to={terms.url || '/terms'}>{t('settings.bridge.termsLink', 'Registry Data Terms')}</Link>
      </p>

      {listError && <div className="alert alert-error">{listError}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}
      {revoked.map((r) => (
        <div key={r.id} className="alert alert-warning">
          {t('settings.bridge.revokedByAdmin', 'The key "{{name}}" was revoked by an administrator on {{date}}.', { name: r.name, date: formatDate(r.revokedAt) })}
          {r.reason ? ` ${t('settings.bridge.revokedReason', 'Reason: {{reason}}', { reason: r.reason })}` : ''}
        </div>
      ))}

      {keys.length === 0 ? (
        <p className="settings-hint">{t('settings.bridge.empty', 'No bridge keys yet.')}</p>
      ) : (
        <ul className="api-token-list">
          {keys.map((k) => (
            <li key={k.id} className="api-token-row">
              <div className="api-token-info">
                <strong>{k.name}</strong>
                <span className="api-token-meta">
                  <code>{k.prefix}…</code>
                  {k.instanceHost ? ` · ${k.instanceHost}` : ''}
                  {' — '}
                  {t('settings.bridge.created', 'Created')} {formatDate(k.createdAt)}
                  {' · '}
                  {k.lastUsedAt
                    ? `${t('settings.bridge.lastUsed', 'Last used')} ${formatDate(k.lastUsedAt)}`
                    : t('settings.bridge.neverUsed', 'Never used')}
                </span>
                <span className="api-token-meta">
                  {usageLine(k)}
                  {k.usage?.importWindow?.active ? ` · ${t('settings.bridge.windowActive', 'import window open')}` : ''}
                </span>
              </div>
              <div className="settings-actions">
                {!k.usage?.importWindow?.active && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => handleImportWindow(k)}
                    disabled={windowBusy === k.id}
                  >
                    {t('settings.bridge.windowBtn', 'Import window')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() => setRevokeTarget(k)}
                >
                  {t('settings.bridge.revokeBtn', 'Revoke')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowCreate(true)}
          disabled={keys.length >= maxActive}
        >
          {t('settings.bridge.createBtn', 'Create bridge key')}
        </button>
        {keys.length >= maxActive && (
          <span className="settings-hint">{t('settings.bridge.capReached', 'Two keys per account. Revoke one to create another.')}</span>
        )}
      </div>

      {/* Once the plaintext key is on screen the dialog must not be dismissable
          by a stray Escape or a click on the backdrop: closing clears it, it is
          shown exactly once, and the cap is two keys per account. "Done" is the
          only way out (audit 2026-09-08). */}
      {showCreate && (
        <Modal
          title={t('settings.bridge.createTitle', 'Create bridge key')}
          onClose={creating || created ? undefined : closeCreate}
          showClose={!creating && !created}
        >
          {created ? (
            <>
              <p>{t('settings.bridge.createdShowOnce', 'Copy these two lines into the .env of your self-hosted Cellarion now and restart its backend. The key will not be shown again.')}</p>
              <code className="api-token-plain" style={{ whiteSpace: 'pre-wrap' }}>{envText}</code>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={handleCopy}>
                  {copied ? t('settings.bridge.copiedBtn', 'Copied!') : t('settings.bridge.copyBtn', 'Copy')}
                </button>
                <button type="button" className="btn btn-primary" onClick={closeCreate}>
                  {t('settings.bridge.doneBtn', 'Done')}
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label htmlFor="bridge-key-name">{t('settings.bridge.nameLabel', 'Name of the install')}</label>
                <input
                  id="bridge-key-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.bridge.namePlaceholder', 'e.g. Home NAS')}
                  maxLength={60}
                  required
                />
              </div>
              {!terms.accepted && (
                <div className="form-group">
                  <label className="api-token-scope-option">
                    <input
                      type="checkbox"
                      checked={acceptTerms}
                      onChange={(e) => setAcceptTerms(e.target.checked)}
                    />
                    {' '}
                    {t('settings.bridge.acceptTerms', 'I accept the Registry Data Terms')}
                    {terms.version ? ` (${terms.version})` : ''}
                    {' '}
                    <Link to={terms.url || '/terms'} target="_blank" rel="noopener noreferrer">{t('settings.bridge.readTerms', 'read them')}</Link>
                  </label>
                </div>
              )}
              {user?.hasPassword === false ? (
                <SetPasswordNotice />
              ) : (
                <div className="form-group">
                  <label htmlFor="bridge-key-password">{t('settings.bridge.passwordLabel', 'Confirm with your password')}</label>
                  <input
                    id="bridge-key-password"
                    type="password"
                    className="input"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <p className="settings-hint">{t('settings.bridge.passwordHint', 'Creating a key requires your account password.')}</p>
                </div>
              )}

              {createError && <div className="alert alert-error">{createError}</div>}

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={creating}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating || user?.hasPassword === false}>
                  {creating ? t('settings.bridge.creatingBtn', 'Creating…') : t('settings.bridge.createConfirmBtn', 'Create key')}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {revokeTarget && (
        <Modal title={t('settings.bridge.revokeTitle', 'Revoke bridge key')} onClose={revoking ? undefined : () => setRevokeTarget(null)}>
          <p>{t('settings.bridge.revokeConfirm', 'Revoke "{{name}}"? The self-hosted Cellarion using it loses registry access immediately; wines it already copied stay.', { name: revokeTarget.name })}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={handleRevoke} disabled={revoking}>
              {revoking ? t('settings.bridge.revokingBtn', 'Revoking…') : t('settings.bridge.revokeBtn', 'Revoke')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default SelfHostedBridgeSection;
