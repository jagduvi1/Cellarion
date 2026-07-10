import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import { listApiTokens, createApiToken, revokeApiToken } from '../api/tokens';

// Personal API tokens (Settings card). Scoped machine credentials for
// integrations like Home Assistant — create (password-confirmed, plaintext
// shown once), list with last-used, revoke.
const ALL_SCOPES = ['read', 'consume'];

function ApiTokensSection() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [tokens, setTokens] = useState([]);
  const [listError, setListError] = useState(null);

  // Create flow
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['read']);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [newToken, setNewToken] = useState(null); // plaintext — shown exactly once
  const [copied, setCopied] = useState(false);

  // Revoke flow
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listApiTokens(apiFetch);
      if (!res.ok) throw new Error();
      setTokens(await res.json());
      setListError(null);
    } catch {
      setListError(t('settings.apiTokens.errorLoad'));
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  const toggleScope = (scope) => {
    setScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]);
  };

  const closeCreate = () => {
    setShowCreate(false);
    setName('');
    setScopes(['read']);
    setPassword('');
    setCreateError(null);
    setNewToken(null);
    setCopied(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (scopes.length === 0) {
      setCreateError(t('settings.apiTokens.errorNoScope'));
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createApiToken(apiFetch, { name: name.trim(), scopes, password });
      // 403 = wrong password confirmation (401 is reserved for session expiry,
      // which apiFetch handles transparently)
      if (res.status === 403) {
        setCreateError(t('settings.apiTokens.errorWrongPassword'));
      } else if (res.status === 429) {
        setCreateError(t('settings.apiTokens.errorRateLimited'));
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error || t('settings.apiTokens.errorGeneric'));
      } else {
        const data = await res.json();
        setNewToken(data.token);
        setPassword('');
        await load();
      }
    } catch {
      setCreateError(t('settings.apiTokens.errorGeneric'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await revokeApiToken(apiFetch, revokeTarget.id);
      if (!res.ok) throw new Error();
      setRevokeTarget(null);
      await load();
    } catch {
      setListError(t('settings.apiTokens.errorGeneric'));
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  };

  const scopeLabel = (scope) => t(`settings.apiTokens.scope_${scope}`);
  const formatDate = (d) => d ? new Date(d).toLocaleDateString() : null;

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">{t('settings.apiTokens.title')}</h2>
      <p className="settings-hint">{t('settings.apiTokens.hint')}</p>

      {listError && <div className="alert alert-error">{listError}</div>}

      {tokens.length === 0 ? (
        <p className="settings-hint">{t('settings.apiTokens.empty')}</p>
      ) : (
        <ul className="api-token-list">
          {tokens.map(tok => (
            <li key={tok.id} className="api-token-row">
              <div className="api-token-info">
                <strong>{tok.name}</strong>
                <span className="api-token-meta">
                  {tok.scopes.map(scopeLabel).join(' · ')}
                  {' — '}
                  {t('settings.apiTokens.created')} {formatDate(tok.createdAt)}
                  {' · '}
                  {tok.lastUsedAt
                    ? `${t('settings.apiTokens.lastUsed')} ${formatDate(tok.lastUsedAt)}`
                    : t('settings.apiTokens.neverUsed')}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-small"
                onClick={() => setRevokeTarget(tok)}
              >
                {t('settings.apiTokens.revokeBtn')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(true)}>
          {t('settings.apiTokens.createBtn')}
        </button>
      </div>

      {showCreate && (
        <Modal title={t('settings.apiTokens.createTitle')} onClose={creating ? undefined : closeCreate} showClose={!creating}>
          {newToken ? (
            <>
              <p>{t('settings.apiTokens.createdShowOnce')}</p>
              <code className="api-token-plain">{newToken}</code>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={handleCopy}>
                  {copied ? t('settings.apiTokens.copiedBtn') : t('settings.apiTokens.copyBtn')}
                </button>
                <button type="button" className="btn btn-primary" onClick={closeCreate}>
                  {t('settings.apiTokens.doneBtn')}
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label htmlFor="api-token-name">{t('settings.apiTokens.nameLabel')}</label>
                <input
                  id="api-token-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('settings.apiTokens.namePlaceholder')}
                  maxLength={100}
                  required
                />
              </div>
              <div className="form-group">
                <span className="api-token-scopes-label">{t('settings.apiTokens.scopesLabel')}</span>
                {ALL_SCOPES.map(scope => (
                  <label key={scope} className="api-token-scope-option">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    {' '}{t(`settings.apiTokens.scopeDesc_${scope}`)}
                  </label>
                ))}
              </div>
              <div className="form-group">
                <label htmlFor="api-token-password">{t('settings.apiTokens.passwordLabel')}</label>
                <input
                  id="api-token-password"
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                />
                <p className="settings-hint">{t('settings.apiTokens.passwordHint')}</p>
              </div>

              {createError && <div className="alert alert-error">{createError}</div>}

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={creating}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? t('settings.apiTokens.creatingBtn') : t('settings.apiTokens.createConfirmBtn')}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {revokeTarget && (
        <Modal title={t('settings.apiTokens.revokeTitle')} onClose={revoking ? undefined : () => setRevokeTarget(null)}>
          <p>{t('settings.apiTokens.revokeConfirm', { name: revokeTarget.name })}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={handleRevoke} disabled={revoking}>
              {revoking ? t('settings.apiTokens.revokingBtn') : t('settings.apiTokens.revokeBtn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ApiTokensSection;
