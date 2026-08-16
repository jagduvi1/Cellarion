import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import {
  adminGetIncompleteGeography,
  adminClearIncompleteGeography,
  adminUnclearIncompleteGeography,
} from '../api/admin';

const PAGE_SIZE = 50;

/**
 * The COMPLETENESS queue: registry rows that are not wrong, just BLANK — no
 * region at all. Every other admin queue keys off a value (a name embedding
 * its producer, a producer that is really a place, two rows colliding on a
 * key), so a region-less row trips none of them and stays invisible; 180 sat
 * on prod the day this shipped, 112 of them owned by real users.
 *
 * Rows are ranked most-owned first, and within that an appellation LEAD (one
 * edit away) before a blank row (research needed). Editing the wine is the
 * fix — this queue only points; a row leaves it by construction the moment a
 * region is set, so the "no region" action exists solely for the wines that
 * legitimately have none (a country-wide designation, a multi-region blend).
 *
 * Interlocks follow WineFragmentationModal: fetch-generation guard, functional
 * state updaters (never derive a new list from the render closure after an
 * await), every action disabled while a POST is in flight, and offset-drain
 * pagination for rows this session removed from the outstanding view.
 *
 * Props: apiFetch (from useAuth()), onClose().
 */
function WineIncompleteGeographyModal({ apiFetch, onClose }) {
  const { t } = useTranslation();
  const [view, setView] = useState('outstanding'); // 'outstanding' | 'cleared'
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [scanned, setScanned] = useState(0);
  const [clearedCount, setClearedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const fetchGen = useRef(0);
  const clearedDelta = useRef(0);

  const fetchPage = useCallback(async (p) => {
    const gen = ++fetchGen.current;
    setLoading(true);
    setError(null);
    try {
      const drained = view === 'outstanding' ? clearedDelta.current : 0;
      const offset = Math.max(0, (p - 1) * PAGE_SIZE - drained);
      const params = new URLSearchParams({ offset, limit: PAGE_SIZE });
      if (view === 'cleared') params.append('includeCleared', '1');
      const res = await adminGetIncompleteGeography(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (gen !== fetchGen.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(data.error || t('admin.wines.incompleteGeo.loadError'));
        return;
      }
      // The cleared view asks for everything and shows only the cleared rows —
      // the endpoint's includeCleared is "don't filter", not "only cleared".
      const rows = view === 'cleared'
        ? (data.rows || []).filter(r => r.cleared)
        : (data.rows || []);
      setItems(rows);
      setTotal(view === 'cleared' ? (data.clearedCount || 0) : (data.total || 0));
      setPages(view === 'cleared' ? 1 : (data.pages || 1));
      setScanned(data.scannedCount || 0);
      setClearedCount(data.clearedCount || 0);
    } catch {
      if (gen === fetchGen.current) setError(t('common.networkError'));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  }, [apiFetch, view, t]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const switchView = (v) => {
    if (v === view || pendingId) return;
    clearedDelta.current = 0;
    setView(v);
    setItems(null);
    setPage(1);
  };

  const act = async (row, clearIt) => {
    setPendingId(row._id);
    setError(null);
    try {
      const call = clearIt ? adminClearIncompleteGeography : adminUnclearIncompleteGeography;
      const res = await call(apiFetch, [row._id]);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('admin.wines.incompleteGeo.actionError'));
        return;
      }
      clearedDelta.current += 1;
      setItems(prev => (prev || []).filter(r => r._id !== row._id));
      setTotal(prev => Math.max(0, prev - 1));
      setClearedCount(prev => Math.max(0, clearIt ? prev + 1 : prev - 1));
      const remaining = (items || []).filter(r => r._id !== row._id).length;
      if (remaining === 0 && total - 1 > 0) {
        if (page > 1) setPage(p => p - 1);
        else fetchPage(1);
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setPendingId(null);
    }
  };

  const badgeStyle = {
    fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem',
    borderRadius: 'var(--radius-sm)', background: 'var(--color-warning-bg)',
    border: '1px solid var(--color-warning-border)', whiteSpace: 'nowrap',
  };
  const rowStyle = {
    display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    alignItems: 'center', padding: '0.5rem 0.15rem',
    borderTop: '1px solid var(--color-border)',
  };
  const mutedStyle = { color: 'var(--color-text-muted)' };

  return (
    <Modal title={t('admin.wines.incompleteGeo.title')} onClose={onClose} wide>
      <p style={{ ...mutedStyle, fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.wines.incompleteGeo.explainer')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={`btn ${view === 'outstanding' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('outstanding')}
        >
          {t('admin.wines.incompleteGeo.viewOutstanding')}
        </button>
        <button
          type="button"
          className={`btn ${view === 'cleared' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('cleared')}
        >
          {t('admin.wines.incompleteGeo.viewCleared', { count: clearedCount })}
        </button>
        {items !== null && !loading && (
          <span style={{ fontSize: '0.85rem', marginLeft: 'auto' }}>
            {t('admin.wines.incompleteGeo.count', { count: total, scanned })}
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading || items === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>
            {view === 'outstanding'
              ? t('admin.wines.incompleteGeo.emptyOutstanding')
              : t('admin.wines.incompleteGeo.emptyCleared')}
          </p>
        </div>
      ) : (
        <div>
          {items.map(r => (
            <div key={r._id} style={rowStyle}>
              <span style={{ flex: '1 1 260px', minWidth: 200 }}>
                <Link to={`/wines/${r._id}`} target="_blank" rel="noopener noreferrer">
                  <strong>{[r.producer, r.name].filter(Boolean).join(' — ')}</strong>
                </Link>
                <span style={{ ...mutedStyle, fontSize: '0.8rem' }}>
                  {r.country ? ` · ${r.country}` : ''}
                </span>
                {/* The appellation is the lead: usually the region follows
                    straight from it, so it is worth showing verbatim. */}
                {r.hasLead && (
                  <span style={{ ...badgeStyle, marginLeft: 8 }}>
                    {t('admin.wines.incompleteGeo.lead', { appellation: r.appellation })}
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...mutedStyle, fontSize: '0.8rem' }}>
                  {t('admin.wines.incompleteGeo.bottleCount', { count: r.bottleCount })}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={!!pendingId}
                  onClick={() => act(r, view === 'outstanding')}
                  title={view === 'outstanding'
                    ? t('admin.wines.incompleteGeo.clearTitle')
                    : t('admin.wines.incompleteGeo.unclearTitle')}
                >
                  {pendingId === r._id
                    ? t('admin.wines.incompleteGeo.saving')
                    : (view === 'outstanding'
                      ? t('admin.wines.incompleteGeo.clear')
                      : t('admin.wines.incompleteGeo.unclear'))}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {items !== null && pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page <= 1 || loading || !!pendingId} onClick={() => setPage(p => p - 1)}>
            {t('common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem' }}>{t('admin.audit.page', { current: page, total: pages })}</span>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page >= pages || loading || !!pendingId} onClick={() => setPage(p => p + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <p style={{ ...mutedStyle, fontSize: '0.8rem', marginBottom: 0 }}>
          {t('admin.wines.incompleteGeo.fixHint')}
        </p>
      )}
    </Modal>
  );
}

export default WineIncompleteGeographyModal;
