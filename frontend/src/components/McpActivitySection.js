import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import { getMcpActivity, revertMcpActivity } from '../api/mcp';

// "Recent AI activity" (Settings card). A plain-language timeline of what a
// connected AI (Claude/ChatGPT via MCP, or a scoped API token) has changed in
// the user's cellar, with one-click revert on recent actions. Read-only for
// tokens — this is the human's oversight surface, reachable only from a logged-
// in session. Backend: GET/POST /api/mcp/activity in routes/mcp.js.
function McpActivitySection() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [activity, setActivity] = useState([]);
  const [windowDays, setWindowDays] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState(null);

  const [revertTarget, setRevertTarget] = useState(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getMcpActivity(apiFetch, { limit: 50 });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setActivity(data.activity || []);
      setWindowDays(data.revert_window_days ?? null);
      setListError(null);
    } catch {
      setListError(t('settings.aiActivity.errorLoad'));
    } finally {
      setLoaded(true);
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  const handleRevert = async () => {
    if (!revertTarget) return;
    setReverting(true);
    setRevertError(null);
    try {
      const res = await revertMcpActivity(apiFetch, revertTarget.id);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // 409/404/403/400 all carry a human message from the reversal engine;
        // the world may have moved on since the timeline was loaded.
        setRevertError(data.error || t('settings.aiActivity.errorRevert'));
        await load(); // refresh — the row's state likely changed
        return;
      }
      setRevertTarget(null);
      await load();
    } catch {
      setRevertError(t('settings.aiActivity.errorRevert'));
    } finally {
      setReverting(false);
    }
  };

  const formatWhen = (d) => {
    try { return new Date(d).toLocaleString(); } catch { return ''; }
  };

  // Nothing has ever happened → hide the card entirely to avoid clutter for the
  // vast majority who haven't connected an AI yet.
  if (loaded && !listError && activity.length === 0) return null;

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">
        {t('settings.aiActivity.title')}
        <span className="settings-beta-badge">{t('settings.aiConnect.beta', 'Beta')}</span>
      </h2>
      <p className="settings-hint">
        {windowDays != null
          ? t('settings.aiActivity.hint', { days: windowDays })
          : t('settings.aiActivity.hintNoWindow')}
      </p>

      {listError && <div className="alert alert-error">{listError}</div>}

      {!loaded ? (
        <p className="settings-hint">{t('common.loading')}</p>
      ) : (
        <ul className="mcp-activity-list">
          {activity.map(entry => (
            <li key={entry.id} className={`mcp-activity-row${entry.reversed ? ' is-reversed' : ''}`}>
              <div className="mcp-activity-info">
                <span className="mcp-activity-summary">{entry.summary}</span>
                <span className="mcp-activity-meta">
                  {formatWhen(entry.created_at)}
                  {' · '}
                  {entry.by === 'token'
                    ? t('settings.aiActivity.byToken')
                    : t('settings.aiActivity.bySession')}
                  {entry.via_undo && <> {' · '}{t('settings.aiActivity.tagUndo')}</>}
                  {entry.reversed && !entry.via_undo && <> {' · '}<span className="mcp-activity-reverted">{t('settings.aiActivity.tagReverted')}</span></>}
                </span>
              </div>
              {entry.revertible && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => { setRevertError(null); setRevertTarget(entry); }}
                >
                  {t('settings.aiActivity.revertBtn')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revertTarget && (
        <Modal
          title={t('settings.aiActivity.revertTitle')}
          onClose={reverting ? undefined : () => setRevertTarget(null)}
          showClose={!reverting}
        >
          <p>{t('settings.aiActivity.revertConfirm', { summary: revertTarget.summary })}</p>
          {revertError && <div className="alert alert-error">{revertError}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setRevertTarget(null)} disabled={reverting}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={handleRevert} disabled={reverting}>
              {reverting ? t('settings.aiActivity.revertingBtn') : t('settings.aiActivity.revertConfirmBtn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default McpActivitySection;
