import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { adminGetWineFragmentation, adminDismissDuplicateCluster } from '../api/admin';

const PAGE_SIZE = 50;

/**
 * Admin review queues for SAME-WINE fragmentation the name-keyed duplicate
 * nets cannot see (curator ticket d4a0e96b): a wine split across records whose
 * name strings genuinely differ never collides on any canonical key.
 *
 * Two modes: "groups" lists records sharing an exact producer + appellation —
 * disjoint vintage sets (the fragments split one wine's vintages between them)
 * sort first, multi-cuvée estates overlap vintages and sink. "pairs" lists
 * near-identical producer spellings inside one appellation (Pierre Charau /
 * Pierre Chanau, Tavel). Review-only, like its siblings: merging goes through
 * the golden-record merge in the duplicates scanner; "Not duplicates" on a
 * group records every pair in the shared not-a-duplicate store, silencing it
 * here, in the cluster scan and in canonical collisions. Pairs have no
 * dismissal — a producer-level judgement doesn't map onto the wine-pair store.
 *
 * Styling follows its siblings (WineCanonicalCollisionsModal): generic classes
 * + inline layout, no bespoke stylesheet.
 *
 * Props: apiFetch (from useAuth()), onClose().
 */
function WineFragmentationModal({ apiFetch, onClose }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('groups');
  const [items, setItems] = useState(null); // groups or pairs, per mode
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [scanned, setScanned] = useState(0);
  const [skippedBuckets, setSkippedBuckets] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingKey, setPendingKey] = useState(null); // group key being dismissed
  const fetchGen = useRef(0);
  // Groups this session dismissed — the set shrinks underneath a fixed
  // page*limit offset, so subtract what we removed (WineLowConfidenceModal's
  // drain pattern). Pairs have no dismissal, so no drain there.
  const dismissedDelta = useRef(0);

  const fetchPage = useCallback(async (p) => {
    const gen = ++fetchGen.current;
    setLoading(true);
    setError(null);
    try {
      const drained = mode === 'groups' ? dismissedDelta.current : 0;
      const offset = Math.max(0, (p - 1) * PAGE_SIZE - drained);
      const params = new URLSearchParams({ mode, offset, limit: PAGE_SIZE });
      const res = await adminGetWineFragmentation(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      // A newer fetch (mode/page change) started while this one was in flight.
      if (gen !== fetchGen.current) return;
      if (!res.ok) {
        setError(data.error || t('admin.wines.fragmentation.loadError'));
        return;
      }
      setItems(mode === 'groups' ? (data.groups || []) : (data.pairs || []));
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setScanned(data.scannedCount || 0);
      setSkippedBuckets(data.skippedBuckets || 0);
    } catch {
      if (gen === fetchGen.current) setError(t('common.networkError'));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  }, [apiFetch, mode, t]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const switchMode = (m) => {
    // Blocked while a dismiss is in flight (belt to the button-disable braces
    // below): its resolve would setItems a groups-shaped list under the pairs
    // renderer → TypeError → app ErrorBoundary (audit 2026-08-10).
    if (m === mode || pendingKey) return;
    dismissedDelta.current = 0;
    setMode(m);
    setItems(null);
    setPage(1);
  };

  const dismissGroup = async (group) => {
    setPendingKey(group.key);
    setError(null);
    try {
      const res = await adminDismissDuplicateCluster(apiFetch, group.wines.map(w => w._id));
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        dismissedDelta.current += 1;
        // Functional updaters, sibling pattern (WineCanonicalCollisionsModal):
        // never derive the new list from the render closure — a snapshot write
        // after an await resurrects concurrently-removed rows. The drain check
        // may use the closure because every interleaving path (second dismiss,
        // mode switch, page change) is disabled while this one is pending.
        setItems(prev => (prev || []).filter(g => g.key !== group.key));
        setTotal(prev => Math.max(0, prev - 1));
        const remaining = (items || []).filter(g => g.key !== group.key).length;
        if (remaining === 0 && total - 1 > 0) {
          if (page > 1) setPage(p => p - 1);
          else fetchPage(1);
        }
      } else {
        setError(data.error || t('admin.wines.fragmentation.dismissError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setPendingKey(null);
    }
  };

  const badgeStyle = {
    fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem',
    borderRadius: 'var(--radius-sm)', background: 'var(--color-warning-bg)',
    border: '1px solid var(--color-warning-border)', whiteSpace: 'nowrap',
  };
  const chipStyle = {
    display: 'inline-block', fontSize: '0.72rem', padding: '0.05rem 0.45rem',
    borderRadius: 999, background: 'var(--color-surface, #f4f4f4)',
    border: '1px solid var(--color-border, #e5e5e5)', whiteSpace: 'nowrap',
  };
  const boxStyle = {
    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
    padding: '0.65rem 0.85rem',
  };
  const memberRowStyle = {
    display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    padding: '0.25rem 0', borderTop: '1px solid var(--color-border)',
  };

  const countKey = mode === 'groups'
    ? 'admin.wines.fragmentation.countGroups'
    : 'admin.wines.fragmentation.countPairs';

  return (
    <Modal title={t('admin.wines.fragmentation.title')} onClose={onClose} wide>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.wines.fragmentation.explainer')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={`btn ${mode === 'groups' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingKey}
          onClick={() => switchMode('groups')}
        >
          {t('admin.wines.fragmentation.modeGroups')}
        </button>
        <button
          type="button"
          className={`btn ${mode === 'pairs' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingKey}
          onClick={() => switchMode('pairs')}
        >
          {t('admin.wines.fragmentation.modePairs')}
        </button>
        {items !== null && !loading && (
          <span style={{ fontSize: '0.85rem', marginLeft: 'auto' }}>
            {t(countKey, { count: total, scanned })}
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {mode === 'pairs' && skippedBuckets > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
          {t('admin.wines.fragmentation.skippedBuckets', { count: skippedBuckets })}
        </div>
      )}

      {loading || items === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>
            {mode === 'groups'
              ? t('admin.wines.fragmentation.emptyGroups')
              : t('admin.wines.fragmentation.emptyPairs')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'groups' && items.map(group => (
            <div key={group.key} style={boxStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <strong>{group.producer}</strong>
                {group.appellation && (
                  <em style={{ color: 'var(--color-text-muted)' }}>{group.appellation}</em>
                )}
                {group.disjoint && (
                  <span style={badgeStyle} title={t('admin.wines.fragmentation.disjointTitle')}>
                    {t('admin.wines.fragmentation.disjointBadge')}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  style={{ marginLeft: 'auto' }}
                  disabled={!!pendingKey}
                  onClick={() => dismissGroup(group)}
                  title={t('admin.wines.fragmentation.dismissTitle')}
                >
                  {pendingKey === group.key
                    ? t('admin.wines.fragmentation.dismissing')
                    : t('admin.wines.fragmentation.dismiss')}
                </button>
              </div>
              {group.wines.map(w => (
                <div key={w._id} style={memberRowStyle}>
                  <span>
                    <Link to={`/wines/${w._id}`} target="_blank" rel="noopener noreferrer">
                      {w.name}
                    </Link>
                    {/* Spelling variants inside the shared producer KEY are part
                        of the evidence — show a member's producer only when its
                        display string differs from the group header's. */}
                    {w.producer !== group.producer && (
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                        {' '}— {w.producer}
                      </span>
                    )}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    {w.vintages.length > 0 ? (
                      w.vintages.map(v => <span key={v} style={chipStyle}>{v}</span>)
                    ) : (
                      <em>{t('admin.wines.fragmentation.noVintages')}</em>
                    )}
                    <span>{t('admin.wines.fragmentation.bottleCount', { count: w.bottleCount })}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}

          {mode === 'pairs' && items.map(pair => (
            <div key={pair.key} style={boxStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <strong>{pair.producers[0].producer}</strong>
                <span style={{ color: 'var(--color-text-muted)' }}>↔</span>
                <strong>{pair.producers[1].producer}</strong>
                {pair.appellation && (
                  <em style={{ color: 'var(--color-text-muted)' }}>· {pair.appellation}</em>
                )}
                <span style={{ ...badgeStyle, marginLeft: 'auto' }}>
                  {t('admin.wines.fragmentation.editDistance', { count: pair.distance })}
                </span>
              </div>
              {pair.producers.map(p => (
                <div key={p.producer} style={memberRowStyle}>
                  <span>
                    <strong>{p.producer}</strong>{' '}
                    <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                      {t('admin.wines.fragmentation.recordCount', { count: p.recordCount })}
                    </span>
                  </span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    {p.sampleNames.join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {items !== null && pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page <= 1 || loading || !!pendingKey} onClick={() => setPage(p => p - 1)}>
            {t('common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem' }}>{t('admin.audit.page', { current: page, total: pages })}</span>
          <button type="button" className="btn btn-secondary btn-small"
            disabled={page >= pages || loading || !!pendingKey} onClick={() => setPage(p => p + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem', marginBottom: 0 }}>
          {t('admin.wines.fragmentation.mergeHint')}
        </p>
      )}
    </Modal>
  );
}

export default WineFragmentationModal;
