import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import {
  adminGetLowConfidenceWines,
  adminMarkProfileReviewed,
  adminUnmarkProfileReviewed,
} from '../api/admin';

const PAGE_SIZE = 50;

/**
 * Admin "model in doubt" review queue. Surfaces registry wines whose AI
 * enrichment confidence is at or below the threshold — the signal that caught
 * the Arcane range-as-producer row after every string rule and the full audit
 * missed it. Rows the enrichment model explicitly distrusts the PRODUCER of
 * carry a pill with its note ("Arcane is a range of Xavier Vignon").
 *
 * "Mark reviewed" records profileReviewedAt; the clearance self-invalidates
 * when the wine is re-enriched (new generatedAt), so an edited wine whose
 * fresh profile is still doubtful re-surfaces by itself. Sibling of
 * WineProducerInNameModal.
 *
 * Props: apiFetch (from useAuth()), onClose(), onChanged().
 */
function WineLowConfidenceModal({ apiFetch, onClose, onChanged }) {
  const { t } = useTranslation();

  const [wines, setWines] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [threshold, setThreshold] = useState(0.3);
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rowErrors, setRowErrors] = useState({});
  const [pending, setPending] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null); // { wine }
  const [successMsg, setSuccessMsg] = useState(null);
  const successTimer = useRef(null);

  const showSuccess = (msg) => {
    clearTimeout(successTimer.current);
    setSuccessMsg(msg);
    successTimer.current = setTimeout(() => setSuccessMsg(null), 3500);
  };
  useEffect(() => () => clearTimeout(successTimer.current), []);

  const fetchPage = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: p, limit: PAGE_SIZE, threshold });
      if (includeReviewed) params.set('includeReviewed', '1');
      const res = await adminGetLowConfidenceWines(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to load (${res.status})`);
        return;
      }
      setWines(data.wines || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setReviewedCount(data.reviewedCount || 0);
      setRowErrors({});
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, threshold, includeReviewed]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const removeRow = (wineId) => {
    const remaining = (wines || []).filter(w => w._id !== wineId);
    const newTotal = Math.max(0, total - 1);
    setWines(remaining);
    setTotal(newTotal);
    setRowErrors(prev => { const { [wineId]: _drop, ...rest } = prev; return rest; });
    if (remaining.length === 0 && newTotal > 0) {
      if (page > 1) setPage(p => p - 1);
      else fetchPage(1);
    }
    onChanged?.();
  };

  const setRowError = (wineId, message) =>
    setRowErrors(prev => ({ ...prev, [wineId]: message }));

  const handleReviewed = async (wine) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminMarkProfileReviewed(apiFetch, wine._id);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(t('admin.wines.lowConfidence.reviewed', { name: wine.name }));
        setPendingUndo({ wine });
        if (includeReviewed) fetchPage(page);
        else removeRow(wine._id);
      } else {
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('common.networkError'));
    } finally {
      setPending(null);
    }
  };

  const handleUndo = async () => {
    const wine = pendingUndo?.wine;
    if (!wine || pending) return;
    setPending(wine._id);
    try {
      const res = await adminUnmarkProfileReviewed(apiFetch, wine._id);
      if (res.ok) {
        setPendingUndo(null);
        fetchPage(page);
        onChanged?.();
      }
    } catch { /* banner stays; retry possible */ } finally {
      setPending(null);
    }
  };

  const handleUnreview = async (wine) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminUnmarkProfileReviewed(apiFetch, wine._id);
      if (res.ok) { fetchPage(page); onChanged?.(); }
      else {
        const data = await res.json().catch(() => ({}));
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('common.networkError'));
    } finally {
      setPending(null);
    }
  };

  const thStyle = {
    textAlign: 'left',
    padding: '0.4rem 0.5rem',
    fontSize: '0.8rem',
    color: 'var(--color-text-secondary, #666)',
    borderBottom: '1px solid var(--color-border, #e5e5e5)',
    whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: '0.45rem 0.5rem',
    borderBottom: '1px solid var(--color-border, #eee)',
    verticalAlign: 'top',
  };
  const pillStyle = {
    display: 'inline-block',
    fontSize: '0.75rem',
    padding: '0.1rem 0.5rem',
    borderRadius: 999,
    background: 'var(--color-surface, #f4f4f4)',
    border: '1px solid var(--color-border, #e5e5e5)',
    whiteSpace: 'nowrap',
  };

  const isReviewed = (w) =>
    w.profileReviewedAt && w.generatedAt &&
    new Date(w.profileReviewedAt) >= new Date(w.generatedAt);

  return (
    <Modal title={t('admin.wines.lowConfidence.title')} onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #666)' }}>
          {t('admin.wines.lowConfidence.intro')}
        </span>
        {wines !== null && !loading && (
          <span style={{
            fontSize: '0.8rem', fontWeight: 600, padding: '0.15rem 0.6rem', borderRadius: 999,
            background: 'var(--color-surface, #f4f4f4)', border: '1px solid var(--color-border, #e5e5e5)', flexShrink: 0,
          }}>
            {t('admin.wines.lowConfidence.found', { count: total })}
            {reviewedCount > 0 && <> · {t('admin.wines.lowConfidence.reviewedNote', { count: reviewedCount })}</>}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <label>
          {t('admin.wines.lowConfidence.thresholdLabel')}:{' '}
          <select
            value={String(threshold)}
            onChange={e => { setThreshold(Number(e.target.value)); setPage(1); }}
            disabled={loading || !!pending}
          >
            <option value="0.2">≤ 0.2</option>
            <option value="0.3">≤ 0.3</option>
            <option value="0.4">≤ 0.4</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeReviewed}
            onChange={e => { setIncludeReviewed(e.target.checked); setPage(1); }}
            disabled={loading || !!pending}
          />
          {t('admin.wines.lowConfidence.includeReviewed')}
        </label>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {successMsg && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>{successMsg}</div>
      )}

      {pendingUndo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '0.5rem 0.75rem', marginBottom: 12, borderRadius: 6,
          background: 'var(--color-surface, #f4f4f4)', border: '1px solid var(--color-border, #e5e5e5)',
          fontSize: '0.85rem',
        }}>
          <span>{t('admin.wines.lowConfidence.reviewed', { name: pendingUndo.wine.name })}</span>
          <button type="button" className="btn btn-secondary" onClick={handleUndo} disabled={!!pending}
            style={{ padding: '0.25rem 0.65rem', fontSize: '0.8rem', flexShrink: 0 }}>
            {t('common.undo')}
          </button>
        </div>
      )}

      {loading && !wines && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-secondary, #888)' }}>
          {t('common.loading')}
        </div>
      )}

      {!loading && wines?.length === 0 && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-secondary, #888)' }}>
          {t('admin.wines.lowConfidence.empty')}
        </div>
      )}

      {wines?.length > 0 && (
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('admin.wines.lowConfidence.confidenceCol')}</th>
                <th style={thStyle}>{t('admin.wines.producerInName.producerCol')}</th>
                <th style={thStyle}>{t('common.name')}</th>
                <th style={thStyle}>{t('admin.wines.lowConfidence.doubtCol')}</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>{t('admin.wines.producerInName.bottlesCol')}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(wine => (
                <tr key={wine._id} style={{ opacity: pending && pending !== wine._id ? 0.6 : 1 }}>
                  <td style={tdStyle}>
                    <span style={{ ...pillStyle, fontWeight: 700 }}>{wine.confidence?.toFixed(1) ?? '—'}</span>
                  </td>
                  <td style={tdStyle}>{wine.producer}</td>
                  <td style={tdStyle}>
                    {wine.name}
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #888)' }}>
                      {[wine.appellation, wine.region, wine.country].filter(Boolean).join(' · ')}
                    </div>
                    {rowErrors[wine._id] && (
                      <div className="alert alert-error" style={{ marginTop: 6, fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}>
                        {rowErrors[wine._id]}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 320 }}>
                    {wine.producerSuspect && (
                      <span style={{ ...pillStyle, fontWeight: 600, marginBottom: 4 }}>
                        {t('admin.wines.lowConfidence.producerSuspect')}
                      </span>
                    )}
                    {wine.producerNote && (
                      <div style={{ fontSize: '0.8rem' }}>{wine.producerNote}</div>
                    )}
                    {!wine.producerSuspect && !wine.producerNote && wine.description && (
                      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary, #888)' }}>
                        {wine.description.slice(0, 140)}{wine.description.length > 140 ? '…' : ''}
                      </div>
                    )}
                    {isReviewed(wine) && (
                      <span style={{ ...pillStyle, fontWeight: 600 }}>
                        {t('admin.wines.lowConfidence.reviewedBadge')}
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{wine.bottleCount}</td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {isReviewed(wine) ? (
                      <button type="button" className="btn btn-secondary btn-small"
                        disabled={!!pending} onClick={() => handleUnreview(wine)}>
                        {t('admin.wines.lowConfidence.unreviewBtn')}
                      </button>
                    ) : (
                      <button type="button" className="btn btn-secondary btn-small"
                        disabled={!!pending}
                        onClick={() => handleReviewed(wine)}
                        title={t('admin.wines.lowConfidence.reviewTitle')}>
                        {pending === wine._id ? t('common.saving') : t('admin.wines.lowConfidence.reviewBtn')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wines !== null && pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page <= 1 || loading || !!pending} onClick={() => setPage(p => p - 1)}>
            {t('common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem' }}>{t('admin.audit.page', { current: page, total: pages })}</span>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page >= pages || loading || !!pending} onClick={() => setPage(p => p + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}
    </Modal>
  );
}

export default WineLowConfidenceModal;
