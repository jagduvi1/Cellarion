import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from '../components/Modal';
import { adminGetBridgeKeys, adminGetBridgeReaders, adminRevokeBridgeKey } from '../api/admin';
import './AdminBridge.css';

// Admin → Registry Bridge: every bridge key with its owner, install and
// spend; the top readers of the registry of every kind; revocation with a
// reason the owner is shown. The page docs/registry-bridge-enforcement.md
// walks through — the numbers that matter are DISTINCT wines per day, not
// requests.

const PLAYBOOK_URL = 'https://github.com/jagduvi1/Cellarion/blob/main/docs/registry-bridge-enforcement.md';
const REASON_MIN = 3;
const REASON_MAX = 300;

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—';
}

function StatCard({ label, value, sublabel }) {
  return (
    <div className="admin-bridge-card">
      <div className="admin-bridge-card-value">{value ?? '—'}</div>
      <div className="admin-bridge-card-label">{label}</div>
      {sublabel && <div className="admin-bridge-card-sub">{sublabel}</div>}
    </div>
  );
}

function KeyStatus({ k, t }) {
  if (k.revokedAt) return <span className="admin-bridge-pill admin-bridge-pill--revoked">{t('adminBridge.statusRevoked')}</span>;
  if (k.importWindow?.active) return <span className="admin-bridge-pill admin-bridge-pill--window">{t('adminBridge.statusWindow')}</span>;
  return <span className="admin-bridge-pill admin-bridge-pill--active">{t('adminBridge.statusActive')}</span>;
}

const KIND_KEY = {
  ip: 'adminBridge.kindIp',
  user: 'adminBridge.kindUser',
  token: 'adminBridge.kindToken',
  key: 'adminBridge.kindKey',
};

function AdminBridge() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [readers, setReaders] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showRevoked, setShowRevoked] = useState(false);

  // Revoke flow
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [kRes, rRes] = await Promise.all([
        adminGetBridgeKeys(apiFetch, days),
        adminGetBridgeReaders(apiFetch, days),
      ]);
      const kBody = await kRes.json();
      const rBody = await rRes.json();
      if (!kRes.ok) throw new Error(kBody.error || 'Failed to load');
      if (!rRes.ok) throw new Error(rBody.error || 'Failed to load');
      setData(kBody);
      setReaders(rBody);
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, days]);

  useEffect(() => { load(); }, [load]);

  const openRevoke = (k) => {
    setRevokeTarget(k);
    setReason('');
    setRevokeError(null);
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await adminRevokeBridgeKey(apiFetch, revokeTarget.id, reason.trim());
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to revoke');
      setRevokeTarget(null);
      setReason('');
      await load();
    } catch (err) {
      setRevokeError(err.message || 'Failed to revoke');
    } finally {
      setRevoking(false);
    }
  };

  const keys = data?.keys || [];
  const revokedKeys = keys.filter((k) => k.revokedAt);
  const shownKeys = showRevoked ? keys : keys.filter((k) => !k.revokedAt);
  const reasonLength = reason.trim().length;
  const reasonOk = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const readerRows = readers?.readers || [];

  return (
    <div className="admin-bridge-page">
      <div className="admin-bridge-header">
        <h1>{t('adminBridge.title')}</h1>
        <div className="admin-bridge-range">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={`admin-bridge-range-btn ${days === d ? 'active' : ''}`}
              onClick={() => setDays(d)}
            >
              {t('adminBridge.lastNDays', { count: d })}
            </button>
          ))}
        </div>
      </div>

      <p className="admin-bridge-note">
        {t('adminBridge.intro')}
        {' '}
        <a href={PLAYBOOK_URL} target="_blank" rel="noopener noreferrer">{t('adminBridge.playbook')}</a>
      </p>

      {error && <div className="admin-bridge-error">{error}</div>}
      {loading && !data && <div className="admin-bridge-loading">{t('common.loading')}</div>}

      {data && (
        <>
          <div className="admin-bridge-cards">
            <StatCard label={t('adminBridge.activeKeys')} value={fmt(data.totals?.active)} />
            <StatCard label={t('adminBridge.usedKeys')} value={fmt(data.totals?.usedInPeriod)} sublabel={t('adminBridge.usedKeysSub')} />
            <StatCard label={t('adminBridge.fetches')} value={fmt(data.totals?.fetches)} sublabel={t('adminBridge.lastNDays', { count: data.days })} />
            <StatCard label={t('adminBridge.searches')} value={fmt(data.totals?.searches)} sublabel={t('adminBridge.lastNDays', { count: data.days })} />
            <StatCard label={t('adminBridge.contributions')} value={fmt(data.totals?.contributions)} sublabel={t('adminBridge.contributionsSub')} />
            <StatCard label={t('adminBridge.revokedKeys')} value={fmt(data.totals?.revoked)} sublabel={t('adminBridge.revokedKeysSub')} />
          </div>

          <p className="admin-bridge-note">
            {t('adminBridge.capsLine', {
              searches: fmt(data.caps?.searches),
              fetches: fmt(data.caps?.fetches),
              contributions: fmt(data.caps?.contributions),
            })}
          </p>

          <div className="admin-bridge-panel">
            <h3>{t('adminBridge.keysTitle')}</h3>
            {keys.length === 0 ? (
              <p className="admin-bridge-empty">{t('adminBridge.noKeys')}</p>
            ) : (
              <>
                <table className="admin-bridge-table">
                  <thead>
                    <tr>
                      <th>{t('adminBridge.key')}</th>
                      <th>{t('adminBridge.owner')}</th>
                      <th>{t('adminBridge.today')}</th>
                      <th>{t('adminBridge.period')}</th>
                      <th>{t('adminBridge.lastUsed')}</th>
                      <th>{t('adminBridge.status')}</th>
                      <th>{t('adminBridge.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownKeys.map((k) => (
                      <tr key={k.id}>
                        <td>
                          <strong>{k.name}</strong>
                          <span className="admin-bridge-sub">
                            <code>{k.prefix}…</code>
                            {k.instanceHost ? ` · ${k.instanceHost}` : ''}
                          </span>
                        </td>
                        <td>
                          {k.owner ? (
                            <>
                              {k.owner.username}
                              <span className="admin-bridge-sub">{k.owner.email}</span>
                            </>
                          ) : '—'}
                        </td>
                        <td>
                          {t('adminBridge.todayLine', {
                            searches: fmt(k.today?.searches),
                            fetches: fmt(k.today?.fetches),
                            distinct: fmt(k.today?.distinct),
                          })}
                        </td>
                        <td>
                          {t('adminBridge.periodLine', {
                            fetches: fmt(k.period?.fetches),
                            searches: fmt(k.period?.searches),
                            contributions: fmt(k.period?.contributions),
                          })}
                          <span className="admin-bridge-sub">{t('adminBridge.distinctMax', { count: k.period?.distinctMax || 0 })}</span>
                        </td>
                        <td>{k.lastUsedAt ? fmtDate(k.lastUsedAt) : t('adminBridge.never')}</td>
                        <td>
                          <KeyStatus k={k} t={t} />
                          {k.revokedAt && (
                            <span className="admin-bridge-sub">
                              {fmtDate(k.revokedAt)}
                              {k.revokedBy ? ` ${t('adminBridge.revokedBy', { name: k.revokedBy })}` : ''}
                              {k.revokedReason ? (
                                <>
                                  <br />
                                  <span className="admin-bridge-reason">{k.revokedReason}</span>
                                </>
                              ) : null}
                            </span>
                          )}
                        </td>
                        <td>
                          {!k.revokedAt && (
                            <button type="button" className="btn btn-danger btn-small" onClick={() => openRevoke(k)}>
                              {t('adminBridge.revoke')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {revokedKeys.length > 0 && (
                  <button type="button" className="admin-bridge-toggle" onClick={() => setShowRevoked((s) => !s)}>
                    {showRevoked ? t('adminBridge.hideRevoked') : t('adminBridge.showRevoked', { count: revokedKeys.length })}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="admin-bridge-panel">
            <h3>{t('adminBridge.readersTitle')}</h3>
            <p className="admin-bridge-note">
              {t('adminBridge.readersIntro', {
                anon: fmt(readers?.thresholds?.anonymousDailyDistinct),
                member: fmt(readers?.thresholds?.memberAlertDistinct),
              })}
            </p>
            {readerRows.length === 0 ? (
              <p className="admin-bridge-empty">{t('adminBridge.noReaders')}</p>
            ) : (
              <table className="admin-bridge-table">
                <thead>
                  <tr>
                    <th>{t('adminBridge.reader')}</th>
                    <th>{t('adminBridge.kind')}</th>
                    <th>{t('adminBridge.worstDay')}</th>
                    <th>{t('adminBridge.reads')}</th>
                    <th>{t('adminBridge.days')}</th>
                    <th>{t('adminBridge.blocked')}</th>
                  </tr>
                </thead>
                <tbody>
                  {readerRows.map((r) => (
                    <tr key={r.readerKey} className={r.overAlert ? 'over-alert' : ''}>
                      <td>
                        {r.label || r.readerKey}
                        {r.owner && r.owner !== r.label ? <span className="admin-bridge-sub">{r.owner}</span> : null}
                        {r.revoked ? <span className="admin-bridge-sub">{t('adminBridge.statusRevoked')}</span> : null}
                      </td>
                      <td><span className="admin-bridge-kind">{t(KIND_KEY[r.kind] || 'adminBridge.kindIp')}</span></td>
                      <td>
                        {fmt(r.distinctMax)}
                        {r.overAlert ? <span className="admin-bridge-sub">{t('adminBridge.overAlert')}</span> : null}
                      </td>
                      <td>{fmt(r.reads)}</td>
                      <td>{fmt(r.days)}</td>
                      <td>{r.blockedDays > 0 ? fmt(r.blockedDays) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {revokeTarget && (
        <Modal title={t('adminBridge.revokeTitle')} onClose={revoking ? undefined : () => setRevokeTarget(null)} showClose={!revoking}>
          <p>{t('adminBridge.revokeConfirm', { name: revokeTarget.name, owner: revokeTarget.owner?.username || '—' })}</p>
          <div className="form-group">
            <label htmlFor="bridge-revoke-reason">{t('adminBridge.reasonLabel')}</label>
            <textarea
              id="bridge-revoke-reason"
              className="admin-bridge-textarea"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              placeholder={t('adminBridge.reasonPlaceholder')}
            />
            <div className="admin-bridge-counter">{reasonLength}/{REASON_MAX} · {t('adminBridge.reasonHint')}</div>
          </div>
          {revokeError && <div className="admin-bridge-error">{revokeError}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={confirmRevoke} disabled={revoking || !reasonOk}>
              {revoking ? t('adminBridge.revoking') : t('adminBridge.revoke')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default AdminBridge;
