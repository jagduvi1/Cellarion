import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetAiBudgetRequests, adminDecideAiBudgetRequest } from '../api/admin';
import './AdminAiBudgetRequests.css';

const GRANT_MAX_DEFAULT = 2000;
const GRANT_DAYS_DEFAULT = 7;
const TABS = ['pending', 'decided'];
const LIMIT = 20;

function AdminAiBudgetRequests() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [tab, setTab] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Per-request approve inputs: { [id]: { grantedMax, days } }
  const [grantInputs, setGrantInputs] = useState({});
  const [submittingId, setSubmittingId] = useState(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT, status: tab });
      const res = await adminGetAiBudgetRequests(apiFetch, params.toString());
      const data = await res.json();
      if (!res.ok) return setError(data.error || t('adminAiBudget.loadError'));
      setRequests(data.requests || []);
      setTotal(data.total || 0);
    } catch {
      setError(t('adminAiBudget.networkError'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, tab, t]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const grantFor = (id) => grantInputs[id] || { grantedMax: GRANT_MAX_DEFAULT, days: GRANT_DAYS_DEFAULT };

  const setGrantField = (id, field, value) => {
    setGrantInputs(prev => ({ ...prev, [id]: { ...grantFor(id), [field]: value } }));
  };

  const handleDecide = async (id, action) => {
    setSubmittingId(id);
    setError(null);
    try {
      const body = action === 'approve'
        ? { action, grantedMax: Number(grantFor(id).grantedMax), days: Number(grantFor(id).days) }
        : { action };
      const res = await adminDecideAiBudgetRequest(apiFetch, id, body);
      const data = await res.json();
      if (!res.ok) return setError(data.error || t('adminAiBudget.decideError'));
      fetchRequests();
    } catch {
      setError(t('adminAiBudget.networkError'));
    } finally {
      setSubmittingId(null);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="admin-ai-budget">
      <h1>{t('adminAiBudget.title')}</h1>
      <p className="aabr-intro">{t('adminAiBudget.intro')}</p>

      <div className="aabr-tabs">
        {TABS.map(s => (
          <button
            key={s}
            className={tab === s ? 'active' : ''}
            onClick={() => { setTab(s); setPage(1); }}
          >
            {t(`adminAiBudget.tabs.${s}`)}
          </button>
        ))}
        <span className="aabr-count">{t('adminAiBudget.count', { count: total })}</span>
      </div>

      {error && <p className="aabr-error">{error}</p>}
      {loading && <p className="aabr-msg">{t('adminAiBudget.loading')}</p>}
      {!loading && requests.length === 0 && (
        <p className="aabr-msg">{t('adminAiBudget.empty')}</p>
      )}

      <div className="aabr-list">
        {requests.map(req => (
          <div key={req._id} className="aabr-item">
            <div className="aabr-item-head">
              <span className="aabr-user">
                {req.user?.username || t('adminAiBudget.deletedUser')}
                {req.user?.email ? ` (${req.user.email})` : ''}
              </span>
              <span className={`aabr-badge status-${req.status}`}>
                {t(`adminAiBudget.status.${req.status}`)}
              </span>
              <span className="aabr-date">{new Date(req.createdAt).toLocaleString()}</span>
            </div>

            {req.reason && <p className="aabr-reason">{req.reason}</p>}
            {req.requestedContext?.pendingRows != null && (
              <p className="aabr-meta">{t('adminAiBudget.pendingRows', { count: req.requestedContext.pendingRows })}</p>
            )}

            {req.status === 'pending' ? (
              <div className="aabr-decide">
                <label>
                  {t('adminAiBudget.grantedMaxLabel')}
                  <input
                    type="number"
                    min="100"
                    max="50000"
                    value={grantFor(req._id).grantedMax}
                    onChange={e => setGrantField(req._id, 'grantedMax', e.target.value)}
                  />
                </label>
                <label>
                  {t('adminAiBudget.daysLabel')}
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={grantFor(req._id).days}
                    onChange={e => setGrantField(req._id, 'days', e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={submittingId === req._id}
                  onClick={() => handleDecide(req._id, 'approve')}
                >
                  {submittingId === req._id ? '…' : t('adminAiBudget.approve')}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={submittingId === req._id}
                  onClick={() => handleDecide(req._id, 'deny')}
                >
                  {submittingId === req._id ? '…' : t('adminAiBudget.deny')}
                </button>
              </div>
            ) : (
              <p className="aabr-decision">
                {req.status === 'approved'
                  ? t('adminAiBudget.approvedSummary', {
                      max: req.grantedMax,
                      date: req.grantedUntil ? new Date(req.grantedUntil).toLocaleDateString() : '—'
                    })
                  : t('adminAiBudget.deniedSummary')}
                {req.decidedBy?.username && (
                  <> — {t('adminAiBudget.decidedBy', {
                    username: req.decidedBy.username,
                    date: req.decidedAt ? new Date(req.decidedAt).toLocaleDateString() : '—'
                  })}</>
                )}
              </p>
            )}
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="aabr-pagination">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>{t('adminAiBudget.prev')}</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>{t('adminAiBudget.next')}</button>
        </div>
      )}
    </div>
  );
}

export default AdminAiBudgetRequests;
