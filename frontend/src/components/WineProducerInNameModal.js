import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import {
  adminGetProducerInNameWines,
  adminStripProducerFromName,
  adminDeleteWine,
  adminVerifyWineChecks,
  adminUnverifyWineChecks,
} from '../api/admin';

const PAGE_SIZE = 50;

/**
 * Admin registry name-check tool (historically "producer in name" — the
 * endpoint kept its path). Surfaces wines whose name looks wrong per the rules
 * in backend utils/nameChecks.js: producer repeated in the name, name
 * identical to producer, a stranded connective ("La Viña de"). Sibling of
 * WineDuplicatesModal.
 *
 * Row actions: Strip (rename to the proposal), "Looks fine" (record a
 * per-rule clearance so the row stops reappearing — with a one-level undo),
 * Delete. A rule picker reaches the non-default cohorts (the ~139 estate
 * name=producer rows), and an audit checkbox ignores clearances entirely so a
 * new/refined rule can be validated before its suppression is trusted.
 *
 * Props:
 *   apiFetch    — from useAuth()
 *   onClose()   — close the modal
 *   onChanged() — called after any successful strip/delete/verify so the
 *                 parent can refresh its wine list
 */
function WineProducerInNameModal({ apiFetch, onClose, onChanged }) {
  const { t } = useTranslation();

  const [wines, setWines] = useState(null); // null = not yet loaded
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [meta, setMeta] = useState(null); // { clearedCount, allCheckIds, checkLabelKeys }
  const [checkFilter, setCheckFilter] = useState(''); // '' = all default checks
  const [includeVerified, setIncludeVerified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rowErrors, setRowErrors] = useState({}); // wineId -> message
  const [pending, setPending] = useState(null); // wineId with an action in flight
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null); // { wine } — last "Looks fine"
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
      const params = new URLSearchParams({ page: p, limit: PAGE_SIZE });
      if (checkFilter) params.set('check', checkFilter);
      if (includeVerified) params.set('includeVerified', '1');
      const res = await adminGetProducerInNameWines(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to load (${res.status})`);
        return;
      }
      setWines(data.wines || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setMeta({
        clearedCount: data.clearedCount || 0,
        allCheckIds: data.allCheckIds || [],
        checkLabelKeys: data.checkLabelKeys || {},
      });
      setRowErrors({});
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, checkFilter, includeVerified]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  // Drop a resolved row from the list. If the page empties while more results
  // remain, step back a page (or refetch page 1) so the admin isn't stranded
  // on an empty page.
  const removeRow = (wineId) => {
    const remaining = (wines || []).filter(w => w._id !== wineId);
    const newTotal = Math.max(0, total - 1);
    setWines(remaining);
    setTotal(newTotal);
    setRowErrors(prev => { const { [wineId]: _drop, ...rest } = prev; return rest; });
    if (remaining.length === 0 && newTotal > 0) {
      if (page > 1) setPage(p => p - 1); // triggers refetch via effect
      else fetchPage(1);
    }
    onChanged?.();
  };

  const setRowError = (wineId, message) =>
    setRowErrors(prev => ({ ...prev, [wineId]: message }));

  const handleStrip = async (wine) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminStripProducerFromName(apiFetch, wine._id);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(t('admin.wines.producerInName.stripped', {
          from: wine.name,
          to: data.wine?.name || wine.proposedName,
        }));
        removeRow(wine._id);
      } else {
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.producerInName.networkError'));
    } finally {
      setPending(null);
    }
  };

  // "Looks fine" — record a clearance for exactly the rules this row tripped.
  // The backend re-detects server-side, so a stale row can't clear a rule the
  // admin never saw. One-level undo via the banner.
  const handleVerify = async (wine) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminVerifyWineChecks(apiFetch, [wine._id], wine.checks);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(t('admin.wines.producerInName.verified', { name: wine.name }));
        setPendingUndo({ wine });
        if (includeVerified) fetchPage(page); // audit view keeps the row, now badged
        else removeRow(wine._id);
      } else {
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.producerInName.networkError'));
    } finally {
      setPending(null);
    }
  };

  const handleUndoVerify = async () => {
    const wine = pendingUndo?.wine;
    if (!wine || pending) return;
    setPending(wine._id);
    try {
      const res = await adminUnverifyWineChecks(apiFetch, [wine._id], wine.checks);
      if (res.ok) {
        setPendingUndo(null);
        fetchPage(page);
        onChanged?.();
      }
    } catch { /* the banner stays; the admin can retry */ } finally {
      setPending(null);
    }
  };

  // Audit view: pull the clearances a cleared row carries for the rules on
  // screen (never rules outside the current view).
  const handleUnverify = async (wine, verifiedForView) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminUnverifyWineChecks(apiFetch, [wine._id], verifiedForView);
      if (res.ok) {
        fetchPage(page);
        onChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.producerInName.networkError'));
    } finally {
      setPending(null);
    }
  };

  const confirmDelete = async () => {
    const wine = deleteCandidate;
    if (!wine || pending) return;
    setPending(wine._id);
    try {
      const res = await adminDeleteWine(apiFetch, wine._id);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(t('admin.wines.producerInName.deleted', { name: wine.name }));
        removeRow(wine._id);
      } else {
        // Blocked deletes (bottles reference the wine) surface the backend error
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.producerInName.networkError'));
    } finally {
      setPending(null);
      setDeleteCandidate(null);
    }
  };

  const reasonLabel = (checkId) => {
    const leaf = meta?.checkLabelKeys?.[checkId];
    return leaf ? t(`admin.wines.producerInName.reasons.${leaf}`) : checkId;
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
    marginRight: 4,
    marginBottom: 2,
    borderRadius: 999,
    background: 'var(--color-surface, #f4f4f4)',
    border: '1px solid var(--color-border, #e5e5e5)',
    whiteSpace: 'nowrap',
  };

  return (
    <Modal title={t('admin.wines.producerInName.title')} onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #666)' }}>
          {t('admin.wines.producerInName.intro')}
        </span>
        {wines !== null && !loading && (
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              padding: '0.15rem 0.6rem',
              borderRadius: 999,
              background: 'var(--color-surface, #f4f4f4)',
              border: '1px solid var(--color-border, #e5e5e5)',
              flexShrink: 0,
            }}
          >
            {t('admin.wines.producerInName.found', { count: total })}
            {meta?.clearedCount > 0 && (
              <> · {t('admin.wines.producerInName.clearedNote', { count: meta.clearedCount })}</>
            )}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <label>
          {t('admin.wines.producerInName.reasonCol')}:{' '}
          <select
            value={checkFilter}
            onChange={e => { setCheckFilter(e.target.value); setPage(1); }}
            disabled={loading || !!pending}
          >
            <option value="">{t('admin.wines.producerInName.allChecks')}</option>
            {(meta?.allCheckIds || []).map(id => (
              <option key={id} value={id}>{reasonLabel(id)}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeVerified}
            onChange={e => { setIncludeVerified(e.target.checked); setPage(1); }}
            disabled={loading || !!pending}
          />
          {t('admin.wines.producerInName.includeVerified')}
        </label>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {successMsg && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>
          {successMsg}
        </div>
      )}

      {pendingUndo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '0.5rem 0.75rem', marginBottom: 12, borderRadius: 6,
          background: 'var(--color-surface, #f4f4f4)', border: '1px solid var(--color-border, #e5e5e5)',
          fontSize: '0.85rem',
        }}>
          <span>
            {t('admin.wines.producerInName.verified', { name: pendingUndo.wine.name })}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleUndoVerify}
            disabled={!!pending}
            style={{ padding: '0.25rem 0.65rem', fontSize: '0.8rem', flexShrink: 0 }}
          >
            {t('common.undo', 'Undo')}
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
          {t('admin.wines.producerInName.empty')}
        </div>
      )}

      {wines?.length > 0 && (
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('admin.wines.producerInName.producerCol')}</th>
                <th style={thStyle}>{t('admin.wines.producerInName.currentNameCol')}</th>
                <th style={thStyle}>{t('admin.wines.producerInName.reasonCol')}</th>
                <th style={thStyle}>{t('admin.wines.producerInName.proposedNameCol')}</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>{t('admin.wines.producerInName.bottlesCol')}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(wine => {
                // Audit view: which of this row's tripped rules are already
                // cleared? Non-empty → badge + Unverify instead of Looks fine.
                const verifiedForView = (wine.checks || [])
                  .filter(id => (wine.verifiedChecks || []).includes(id));
                return (
                  <tr key={wine._id} style={{ opacity: pending && pending !== wine._id ? 0.6 : 1 }}>
                    <td style={tdStyle}>{wine.producer}</td>
                    <td style={tdStyle}>{wine.name}</td>
                    <td style={tdStyle}>
                      {(wine.checks || []).map(id => (
                        <span key={id} style={pillStyle}>{reasonLabel(id)}</span>
                      ))}
                      {verifiedForView.length > 0 && (
                        <span style={{ ...pillStyle, fontWeight: 600 }}>
                          {t('admin.wines.producerInName.verifiedBadge')}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {wine.proposedName || '—'}
                      {rowErrors[wine._id] && (
                        <div className="alert alert-error" style={{ marginTop: 6, fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}>
                          {rowErrors[wine._id]}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{wine.bottleCount}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={!!pending || !wine.proposedName}
                        onClick={() => handleStrip(wine)}
                        title={t('admin.wines.producerInName.stripTitle')}
                      >
                        {pending === wine._id
                          ? t('admin.wines.producerInName.stripping')
                          : t('admin.wines.producerInName.stripBtn')}
                      </button>{' '}
                      {verifiedForView.length > 0 ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={!!pending}
                          onClick={() => handleUnverify(wine, verifiedForView)}
                        >
                          {t('admin.wines.producerInName.unverifyBtn')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={!!pending}
                          onClick={() => handleVerify(wine)}
                          title={t('admin.wines.producerInName.verifyTitle')}
                        >
                          {pending === wine._id
                            ? t('common.saving')
                            : t('admin.wines.producerInName.verifyBtn')}
                        </button>
                      )}{' '}
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        disabled={!!pending}
                        onClick={() => setDeleteCandidate(wine)}
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {wines !== null && pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={page <= 1 || loading || !!pending}
            onClick={() => setPage(p => p - 1)}
          >
            {t('common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem' }}>{t('admin.audit.page', { current: page, total: pages })}</span>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={page >= pages || loading || !!pending}
            onClick={() => setPage(p => p + 1)}
          >
            {t('common.next')}
          </button>
        </div>
      )}

      {/* Delete confirmation — same pattern as the AdminWines page */}
      {deleteCandidate && (
        <Modal title={t('admin.wines.deleteTitle')} onClose={() => setDeleteCandidate(null)}>
          <p>{t('admin.wines.deleteConfirm', { name: deleteCandidate.name })}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDeleteCandidate(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!!pending}
              onClick={confirmDelete}
            >
              {pending ? t('common.saving') : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

export default WineProducerInNameModal;
