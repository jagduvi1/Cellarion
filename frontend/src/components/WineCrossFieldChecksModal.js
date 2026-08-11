import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import {
  adminGetCrossFieldChecks,
  adminClearCrossChecks,
  adminUnclearCrossChecks,
} from '../api/admin';

const PAGE_SIZE = 50;

/**
 * Admin CROSS-FIELD check queue (ticket analysis 2026-08-10, Tier-2 item 5) —
 * sibling of WineProducerInNameModal, backed by backend
 * utils/crossFieldChecks.js: registry values sitting in the wrong FIELD,
 * caught by testing them against the reference lists the app already holds
 * (producer "Monbazillac" = an appellation, producer "Dragasani" = a region,
 * region "Spain" = a country, appellation "Cabernet Sauvignon" = a grape,
 * producer "Roșu Demidulce" = a style term, "Domaine unknown" = a
 * placeholder, name "Wines" ⊂ producer "The Freaky Wines", a parenthetical
 * producer). Review only — the scan flags, it never blocks a write.
 *
 * Row actions: open the wine (fixing happens on the wine, in the existing
 * edit form — this queue proposes nothing), and "Looks fine" (record a
 * per-rule clearance so the row stops reappearing, with a one-level undo).
 * A rule picker scopes to one rule; the audit checkbox ignores clearances so
 * a new/refined rule can be validated across the whole registry before its
 * suppression is trusted.
 *
 * Props:
 *   apiFetch    — from useAuth()
 *   onClose()   — close the modal
 */
function WineCrossFieldChecksModal({ apiFetch, onClose }) {
  const { t } = useTranslation();

  const [wines, setWines] = useState(null); // null = not yet loaded
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [meta, setMeta] = useState(null); // { clearedCount, allCheckIds, checkLabelKeys, checkFields, ruleCounts }
  const [checkFilter, setCheckFilter] = useState(''); // '' = all default checks
  const [includeCleared, setIncludeCleared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rowErrors, setRowErrors] = useState({}); // wineId -> message
  const [pending, setPending] = useState(null); // wineId with an action in flight
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
      if (includeCleared) params.set('includeCleared', '1');
      const res = await adminGetCrossFieldChecks(apiFetch, params);
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
        checkFields: data.checkFields || {},
        ruleCounts: data.ruleCounts || {},
      });
      setRowErrors({});
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, checkFilter, includeCleared]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  // Drop a resolved row from the list. If the page empties while more results
  // remain, step back a page (or refetch page 1) so the admin isn't stranded
  // on an empty page — same drain pattern as the name-checks modal. Reading
  // the closure values is safe here: the `pending` interlock serializes row
  // actions, so no second removal can interleave.
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
  };

  const setRowError = (wineId, message) =>
    setRowErrors(prev => ({ ...prev, [wineId]: message }));

  // "Looks fine" — record a clearance for exactly the rules this row tripped.
  // The backend re-detects server-side, so a stale row can't clear a rule the
  // admin never saw. One-level undo via the banner.
  const handleClear = async (wine) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const checks = (wine.hits || []).map(h => h.check);
      const res = await adminClearCrossChecks(apiFetch, [wine._id], checks);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(t('admin.wines.crossField.cleared', { name: wine.name }));
        setPendingUndo({ wine });
        if (includeCleared) fetchPage(page); // audit view keeps the row, now badged
        else removeRow(wine._id);
      } else {
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.crossField.networkError'));
    } finally {
      setPending(null);
    }
  };

  const handleUndoClear = async () => {
    const wine = pendingUndo?.wine;
    if (!wine || pending) return;
    setPending(wine._id);
    try {
      const checks = (wine.hits || []).map(h => h.check);
      const res = await adminUnclearCrossChecks(apiFetch, [wine._id], checks);
      if (res.ok) {
        setPendingUndo(null);
        fetchPage(page);
      } else {
        // Row may already be gone from the list, so surface at modal level —
        // the banner stays so the admin can retry.
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to undo (${res.status})`);
      }
    } catch { /* the banner stays; the admin can retry */ } finally {
      setPending(null);
    }
  };

  // Audit view: remove the clearances a cleared row carries for the rules on
  // screen (never rules outside the current view).
  const handleUnclear = async (wine, clearedForView) => {
    if (pending) return;
    setPending(wine._id);
    setRowError(wine._id, null);
    try {
      const res = await adminUnclearCrossChecks(apiFetch, [wine._id], clearedForView);
      if (res.ok) {
        fetchPage(page);
      } else {
        const data = await res.json().catch(() => ({}));
        setRowError(wine._id, data.error || `Failed (${res.status})`);
      }
    } catch {
      setRowError(wine._id, t('admin.wines.crossField.networkError'));
    } finally {
      setPending(null);
    }
  };

  const reasonLabel = (checkId) => {
    const leaf = meta?.checkLabelKeys?.[checkId];
    return leaf ? t(`admin.wines.crossField.reasons.${leaf}`) : checkId;
  };

  // Which wine field a rule is about ('producer'/'name'/'appellation'/'region')
  // → the row value the hit refers to, shown beside what it matched.
  const offendingValue = (wine, checkId) => {
    const field = meta?.checkFields?.[checkId];
    return field ? (wine[field] || '') : '';
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
    <Modal title={t('admin.wines.crossField.title')} onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #666)' }}>
          {t('admin.wines.crossField.intro')}
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
            {t('admin.wines.crossField.found', { count: total })}
            {meta?.clearedCount > 0 && (
              <> · {t('admin.wines.crossField.clearedNote', { count: meta.clearedCount })}</>
            )}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <label>
          {t('admin.wines.crossField.whyCol')}:{' '}
          <select
            value={checkFilter}
            onChange={e => { setCheckFilter(e.target.value); setPage(1); }}
            disabled={loading || !!pending}
          >
            <option value="">{t('admin.wines.crossField.allChecks')}</option>
            {(meta?.allCheckIds || []).map(id => (
              <option key={id} value={id}>
                {reasonLabel(id)}
                {typeof meta?.ruleCounts?.[id] === 'number' ? ` (${meta.ruleCounts[id]})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeCleared}
            onChange={e => { setIncludeCleared(e.target.checked); setPage(1); }}
            disabled={loading || !!pending}
          />
          {t('admin.wines.crossField.includeCleared')}
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
            {t('admin.wines.crossField.cleared', { name: pendingUndo.wine.name })}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleUndoClear}
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
          {t('admin.wines.crossField.empty')}
        </div>
      )}

      {wines?.length > 0 && (
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('admin.wines.crossField.producerCol')}</th>
                <th style={thStyle}>{t('admin.wines.crossField.nameCol')}</th>
                <th style={thStyle}>{t('admin.wines.crossField.appellationCol')}</th>
                <th style={thStyle}>{t('admin.wines.crossField.whyCol')}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(wine => {
                // Audit view: which of this row's tripped rules are already
                // cleared? Non-empty → badge + Unclear instead of Looks fine.
                const clearedForView = (wine.hits || [])
                  .map(h => h.check)
                  .filter(id => (wine.cleared || []).includes(id));
                return (
                  <tr key={wine._id} style={{ opacity: pending && pending !== wine._id ? 0.6 : 1 }}>
                    <td style={tdStyle}>{wine.producer}</td>
                    <td style={tdStyle}>
                      <Link to={`/wines/${wine._id}`} target="_blank" rel="noopener noreferrer">
                        {wine.name}
                      </Link>
                    </td>
                    <td style={tdStyle}>{wine.appellation || '—'}</td>
                    <td style={tdStyle}>
                      {(wine.hits || []).map(h => (
                        <div key={h.check} style={{ marginBottom: 2 }}>
                          <span style={pillStyle}>{reasonLabel(h.check)}</span>
                          <span style={{ fontSize: '0.8rem' }}>
                            {offendingValue(wine, h.check)} → <strong>{h.detail}</strong>
                          </span>
                        </div>
                      ))}
                      {clearedForView.length > 0 && (
                        <span style={{ ...pillStyle, fontWeight: 600 }}>
                          {t('admin.wines.crossField.clearedBadge')}
                        </span>
                      )}
                      {rowErrors[wine._id] && (
                        <div className="alert alert-error" style={{ marginTop: 6, fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}>
                          {rowErrors[wine._id]}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {clearedForView.length > 0 ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={!!pending}
                          onClick={() => handleUnclear(wine, clearedForView)}
                        >
                          {t('admin.wines.crossField.unclearBtn')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={!!pending}
                          onClick={() => handleClear(wine)}
                          title={t('admin.wines.crossField.clearTitle')}
                        >
                          {pending === wine._id
                            ? t('common.saving')
                            : t('admin.wines.crossField.clearBtn')}
                        </button>
                      )}
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
    </Modal>
  );
}

export default WineCrossFieldChecksModal;
