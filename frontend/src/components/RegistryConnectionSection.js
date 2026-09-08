import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getBridgeStatus, setBridgeRefreshMode } from '../api/bridge';
import { HOSTED_ORIGIN } from '../utils/mcpConnect';

// Settings card on a SELF-HOSTED install: whether this server is connected to
// the shared wine registry on cellarion.app (Registry Bridge), what it has
// copied so far, and today's quota use — or, when it is not connected, the
// three steps to connect it. The key itself lives in the server's .env and is
// never shown here. Not rendered on the hosted instance (Settings.js gates it).
function RegistryConnectionSection() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState(null);
  const isAdmin = !!user?.roles?.includes('admin');

  const load = useCallback(async () => {
    try {
      const res = await getBridgeStatus(apiFetch);
      if (!res.ok) throw new Error();
      setStatus(await res.json());
      setError(null);
    } catch {
      setError(t('settings.registryConnection.errorLoad', 'Failed to read the registry connection.'));
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  // The weekly refresh switch: install-wide, admins only, and only when the
  // server's .env has not already decided (REGISTRY_BRIDGE_REFRESH).
  const toggleRefresh = async () => {
    if (!status?.refresh) return;
    const next = status.refresh.mode === 'off' ? 'weekly' : 'off';
    setRefreshBusy(true);
    setRefreshNotice(null);
    try {
      const res = await setBridgeRefreshMode(apiFetch, next);
      if (res.status === 409) {
        setRefreshNotice(t('settings.registryConnection.refreshEnvOverride', 'REGISTRY_BRIDGE_REFRESH is set in this server\'s .env; change it there and restart the backend.'));
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRefreshNotice(data.error || t('settings.registryConnection.errorGeneric', 'Something went wrong. Please try again.'));
      } else {
        setRefreshNotice(t('settings.registryConnection.refreshSaved', 'Saved. The change applies from the next weekly run.'));
        await load();
      }
    } catch {
      setRefreshNotice(t('settings.registryConnection.errorGeneric', 'Something went wrong. Please try again.'));
    } finally {
      setRefreshBusy(false);
    }
  };

  const formatDate = (d) => (d ? new Date(d).toLocaleString() : null);
  const reasonText = (reason) => ({
    no_key: t('settings.registryConnection.reasonNoKey', 'No bridge key is configured on this server.'),
    bad_key: t('settings.registryConnection.reasonBadKey', 'REGISTRY_BRIDGE_KEY is set but is not a bridge key (they start with cbr_).'),
    self_target: t('settings.registryConnection.reasonSelfTarget', 'REGISTRY_BRIDGE_URL points at this very install.'),
  }[reason] || '');

  const usage = status?.me?.usage;
  const used = usage?.used || {};
  const caps = usage?.caps || {};

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">{t('settings.registryConnection.title', 'Shared wine registry')}</h2>
      <p className="settings-hint">
        {t('settings.registryConnection.hint', 'The shared registry on cellarion.app holds curated wines with tasting profiles and drink windows. A connected install shows registry matches in the add-bottle search and copies the wines you pick, one at a time.')}
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      {status && status.enabled && (
        <>
          <div className="ai-connect-oneclick">
            <div>
              <strong>{t('settings.registryConnection.connected', 'Connected')}</strong>
              {' · '}{status.url}
              {status.keyPrefix ? ` · ${t('settings.registryConnection.keyPrefix', 'key')} ${status.keyPrefix}…` : ''}
            </div>
          </div>
          <ul className="api-token-list">
            <li className="api-token-row">
              <div className="api-token-info">
                <strong>{t('settings.registryConnection.heldCopies', '{{count}} wines copied from the registry', { count: status.held })}</strong>
                <span className="api-token-meta">
                  {status.removed > 0 ? `${t('settings.registryConnection.removedCopies', '{{count}} no longer in the registry', { count: status.removed })} · ` : ''}
                  {status.lastRefresh?.at
                    ? t('settings.registryConnection.lastRefresh', 'Last refresh {{when}}: {{updated}} updated, {{removed}} removed', { when: formatDate(status.lastRefresh.at), updated: status.lastRefresh.updated ?? 0, removed: status.lastRefresh.removed ?? 0 })
                    : t('settings.registryConnection.neverRefreshed', 'Copies refresh weekly on Monday mornings.')}
                </span>
                {usage && (
                  <span className="api-token-meta">
                    {t('settings.registryConnection.quotaLine', 'Today: {{searches}}/{{searchCap}} searches · {{fetches}}/{{fetchCap}} wines copied', {
                      searches: used.searches || 0, searchCap: caps.searches || 0, fetches: used.fetches || 0, fetchCap: caps.fetches || 0,
                    })}
                    {usage.importWindow?.active ? ` · ${t('settings.registryConnection.importWindowActive', 'import window open')}` : ''}
                  </span>
                )}
              </div>
            </li>
          </ul>
          {status.refresh && (
            <p className="settings-hint">
              {status.refresh.mode === 'off'
                ? t('settings.registryConnection.refreshOff', 'Weekly refresh is off: copied wines stay exactly as they were copied.')
                : t('settings.registryConnection.refreshOn', 'Copied wines refresh weekly from the registry. Anything changed on this install (a drink window, a value, the identity) is kept.')}
              {status.refresh.source === 'env' ? ` ${t('settings.registryConnection.refreshEnv', 'Set by REGISTRY_BRIDGE_REFRESH in this server\'s .env.')}` : ''}
            </p>
          )}
          {status.refresh && isAdmin && status.refresh.source !== 'env' && (
            <div className="settings-actions">
              <button type="button" className="btn btn-secondary btn-small" onClick={toggleRefresh} disabled={refreshBusy}>
                {status.refresh.mode === 'off'
                  ? t('settings.registryConnection.refreshTurnOn', 'Turn weekly refresh on')
                  : t('settings.registryConnection.refreshTurnOff', 'Turn weekly refresh off')}
              </button>
            </div>
          )}
          {refreshNotice && <div className="alert alert-info">{refreshNotice}</div>}
          {status.blocked && (
            <div className="alert alert-info">
              {t('settings.registryConnection.blocked', 'The registry answered "{{reason}}"; this install pauses its requests until {{until}}.', { reason: status.blocked.reason, until: formatDate(status.blocked.until) })}
            </div>
          )}
          {!status.blocked && status.lastError && (
            <div className="alert alert-info">
              {t('settings.registryConnection.lastError', 'Last problem reaching the registry: {{message}} ({{when}}).', { message: status.lastError.message || status.lastError.code, when: formatDate(status.lastError.at) })}
            </div>
          )}
        </>
      )}

      {status && !status.enabled && (
        <>
          <p className="settings-hint">
            <strong>{t('settings.registryConnection.notConnected', 'Not connected.')}</strong> {reasonText(status.reason)}
          </p>
          <ol className="settings-hint">
            <li>{t('settings.registryConnection.step1', 'Sign in on cellarion.app and open Settings → "Connect a self-hosted Cellarion".')}</li>
            <li>{t('settings.registryConnection.step2', 'Accept the Registry Data Terms, name this install and create a key.')}</li>
            <li>{t('settings.registryConnection.step3', 'Put the two lines into this server\'s .env and restart the backend.')}</li>
          </ol>
          <div className="settings-actions">
            <a className="btn btn-secondary" href={`${HOSTED_ORIGIN}/settings`} target="_blank" rel="noopener noreferrer">
              {t('settings.registryConnection.hostedSettingsLink', 'Open cellarion.app settings')}
            </a>
            <a className="btn btn-secondary" href="https://github.com/jagduvi1/Cellarion/blob/main/docs/registry-bridge.md" target="_blank" rel="noopener noreferrer">
              {t('settings.registryConnection.docsLink', 'How the bridge works')}
            </a>
          </div>
        </>
      )}
    </div>
  );
}

export default RegistryConnectionSection;
