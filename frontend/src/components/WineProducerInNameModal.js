import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import {
  adminGetProducerInNameWines,
  adminStripProducerFromName,
  adminDeleteWine,
} from '../api/admin';

const PAGE_SIZE = 50;

/**
 * Admin cleanup tool for wines whose name starts with their own producer
 * (e.g. producer "Meerlust", name "Meerlust Chardonnay" — should be just
 * "Chardonnay"). Mostly AI-import artefacts. Sibling of WineDuplicatesModal.
 *
 * Props:
 *   apiFetch    — from useAuth()
 *   onClose()   — close the modal
 *   onChanged() — called after any successful strip/delete so the parent can
 *                 refresh its wine list
 */
function WineProducerInNameModal({ apiFetch, onClose, onChanged }) {
  const { t } = useTranslation();

  const [wines, setWines] = useState(null); // null = not yet loaded
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rowErrors, setRowErrors] = useState({}); // wineId -> message
  const [pending, setPending] = useState(null); // wineId with an action in flight
  const [deleteCandidate, setDeleteCandidate] = useState(null);
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
      const res = await adminGetProducerInNameWines(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to load (${res.status})`);
        return;
      }
      setWines(data.wines || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setRowErrors({});
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

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

  const thStyle = {
    textAlign: 'left',
    padding: '0.4rem 0.5rem',
    fontSize: '0.8rem',
    color: 'var(--text-secondary, #666)',
    borderBottom: '1px solid var(--border, #e5e5e5)',
    whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: '0.45rem 0.5rem',
    borderBottom: '1px solid var(--border, #eee)',
    verticalAlign: 'top',
  };

  return (
    <Modal title={t('admin.wines.producerInName.title')} onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #666)' }}>
          {t('admin.wines.producerInName.intro')}
        </span>
        {wines !== null && !loading && (
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              padding: '0.15rem 0.6rem',
              borderRadius: 999,
              background: 'var(--bg-secondary, #f4f4f4)',
              border: '1px solid var(--border, #e5e5e5)',
              flexShrink: 0,
            }}
          >
            {t('admin.wines.producerInName.found', { count: total })}
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      {successMsg && (
        <div className="alert alert-success" role="status" style={{ marginBottom: 12 }}>
          {successMsg}
        </div>
      )}

      {loading && !wines && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
          {t('common.loading')}
        </div>
      )}

      {!loading && wines?.length === 0 && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
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
                <th style={thStyle}>{t('admin.wines.producerInName.proposedNameCol')}</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>{t('admin.wines.producerInName.bottlesCol')}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(wine => (
                <tr key={wine._id} style={{ opacity: pending && pending !== wine._id ? 0.6 : 1 }}>
                  <td style={tdStyle}>{wine.producer}</td>
                  <td style={tdStyle}>{wine.name}</td>
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
              ))}
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
