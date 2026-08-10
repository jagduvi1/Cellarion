import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { adminGetWineProposals, adminApproveWineProposal, adminRejectWineProposal } from '../api/admin';

const PAGE_SIZE = 20;

const KIND_KEYS = {
  field_correction: 'admin.wines.proposals.kindFieldCorrection',
  merge: 'admin.wines.proposals.kindMerge',
  non_wine: 'admin.wines.proposals.kindNonWine',
};

const FIELD_KEYS = {
  producer: 'admin.wines.proposals.fields.producer',
  name: 'admin.wines.proposals.fields.name',
  appellation: 'admin.wines.proposals.fields.appellation',
  region: 'admin.wines.proposals.fields.region',
  country: 'admin.wines.proposals.fields.country',
  classification: 'admin.wines.proposals.fields.classification',
};

const wineLabel = (w) => (w ? [w.producer, w.name].filter(Boolean).join(' — ') : null);

/**
 * Admin review queue for sommelier correction PROPOSALS (identity-field fixes,
 * merges, non-wine flags — filed from the maturity queue via the MCP tool
 * propose_wine_correction). Identity fields stay human-gated because curator
 * assertions on producer/name have been confidently wrong; this modal shows
 * the per-field diff + evidence so the admin applies or rejects in one click
 * instead of re-typing research out of a prose ticket.
 *
 * Interlocks follow WineFragmentationModal exactly: functional state updaters
 * (never derive the new list from the render closure after an await), EVERY
 * action button + pagination + filter switch disabled while a POST is pending,
 * and the offset-drain pagination for rows this session removed from the
 * pending view.
 *
 * Styling follows its siblings: generic classes + inline layout, no bespoke
 * stylesheet.
 *
 * Props: apiFetch (from useAuth()), onClose(), onChanged?() — fired after any
 * decision so the opener can refresh its pending badge.
 */
function WineProposalsModal({ apiFetch, onClose, onChanged }) {
  const { t } = useTranslation();
  const [statusView, setStatusView] = useState('pending'); // 'pending' | 'decided'
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null); // proposal id with a POST in flight
  const [rejectingId, setRejectingId] = useState(null); // row showing the inline reason input
  const [rejectReason, setRejectReason] = useState('');
  const fetchGen = useRef(0);
  // Rows this session decided leave the pending view — the set shrinks under a
  // fixed page*limit offset, so subtract what we removed (the fragmentation
  // modal's drain pattern). The decided view is append-only here: no drain.
  const decidedDelta = useRef(0);

  const fetchPage = useCallback(async (p) => {
    const gen = ++fetchGen.current;
    setLoading(true);
    setError(null);
    try {
      const drained = statusView === 'pending' ? decidedDelta.current : 0;
      const offset = Math.max(0, (p - 1) * PAGE_SIZE - drained);
      const params = new URLSearchParams({ status: statusView, offset, limit: PAGE_SIZE });
      const res = await adminGetWineProposals(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      // A newer fetch (view/page change) started while this one was in flight.
      if (gen !== fetchGen.current) return;
      if (!res.ok) {
        setError(data.error || t('admin.wines.proposals.loadError'));
        return;
      }
      setItems(data.proposals || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setPendingCount(data.pendingCount || 0);
    } catch {
      if (gen === fetchGen.current) setError(t('common.networkError'));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  }, [apiFetch, statusView, t]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const switchView = (v) => {
    // Blocked while a decision is in flight (belt to the button-disable braces
    // below): its resolve would drain rows out of the wrong view's list.
    if (v === statusView || pendingId) return;
    decidedDelta.current = 0;
    setStatusView(v);
    setItems(null);
    setRejectingId(null);
    setRejectReason('');
    setPage(1);
  };

  // Shared post-decision bookkeeping for the pending view: drop the row via
  // functional updaters and refill the page when it drained empty.
  const removeDecidedRow = (id) => {
    decidedDelta.current += 1;
    setItems(prev => (prev || []).filter(x => x._id !== id));
    setTotal(prev => Math.max(0, prev - 1));
    setPendingCount(prev => Math.max(0, prev - 1));
    // The drain check may use the closure: every interleaving path (second
    // decision, view switch, page change) is disabled while one is pending.
    const remaining = (items || []).filter(x => x._id !== id).length;
    if (remaining === 0 && total - 1 > 0) {
      if (page > 1) setPage(p => p - 1);
      else fetchPage(1);
    }
  };

  const approve = async (proposal) => {
    // Approving supersedes a half-typed reject on the same row — close the
    // input so the in-flight labels can't point at the wrong action.
    if (rejectingId === proposal._id) { setRejectingId(null); setRejectReason(''); }
    setPendingId(proposal._id);
    setError(null);
    try {
      const res = await adminApproveWineProposal(apiFetch, proposal._id);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        removeDecidedRow(proposal._id);
        onChanged?.();
      } else {
        setError(data.error || t('admin.wines.proposals.approveError'));
        // A 409 means another admin decided it first — refresh so the stale
        // row leaves the list instead of inviting a second click.
        if (res.status === 409) fetchPage(page);
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setPendingId(null);
    }
  };

  const reject = async (proposal) => {
    const reason = rejectReason.trim();
    if (reason.length < 5) {
      setError(t('admin.wines.proposals.rejectReasonRequired'));
      return;
    }
    setPendingId(proposal._id);
    setError(null);
    try {
      const res = await adminRejectWineProposal(apiFetch, proposal._id, reason);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRejectingId(null);
        setRejectReason('');
        removeDecidedRow(proposal._id);
        onChanged?.();
      } else {
        setError(data.error || t('admin.wines.proposals.rejectError'));
        if (res.status === 409) fetchPage(page);
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setPendingId(null);
    }
  };

  const kindBadgeStyle = {
    fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem',
    borderRadius: 'var(--radius-sm)', background: 'var(--color-warning-bg)',
    border: '1px solid var(--color-warning-border)', whiteSpace: 'nowrap',
  };
  const boxStyle = {
    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
    padding: '0.65rem 0.85rem',
  };
  const diffRowStyle = {
    display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline',
    padding: '0.15rem 0', fontSize: '0.85rem',
  };
  const mutedStyle = { color: 'var(--color-text-muted)' };

  return (
    <Modal title={t('admin.wines.proposals.title')} onClose={onClose} wide>
      <p style={{ ...mutedStyle, fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.wines.proposals.explainer')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={`btn ${statusView === 'pending' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('pending')}
        >
          {t('admin.wines.proposals.viewPending', { count: pendingCount })}
        </button>
        <button
          type="button"
          className={`btn ${statusView === 'decided' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('decided')}
        >
          {t('admin.wines.proposals.viewDecided')}
        </button>
        {items !== null && !loading && (
          <span style={{ fontSize: '0.85rem', marginLeft: 'auto' }}>
            {t('admin.wines.proposals.count', { count: total })}
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading || items === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>
            {statusView === 'pending'
              ? t('admin.wines.proposals.emptyPending')
              : t('admin.wines.proposals.emptyDecided')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map(p => (
            <div key={p._id} style={boxStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={kindBadgeStyle}>{t(KIND_KEYS[p.kind] || KIND_KEYS.field_correction)}</span>
                {p.wineDefinition ? (
                  <Link to={`/wines/${p.wineDefinition._id}`} target="_blank" rel="noopener noreferrer">
                    <strong>{wineLabel(p.wineDefinition)}</strong>
                  </Link>
                ) : (
                  <strong style={mutedStyle}>
                    {wineLabel(p.currentSnapshot) || t('admin.wines.proposals.wineGone')}
                  </strong>
                )}
                {p.status !== 'pending' && (
                  <span style={{ ...kindBadgeStyle, background: 'var(--color-surface, #f4f4f4)', border: '1px solid var(--color-border)' }}>
                    {p.status === 'approved'
                      ? t('admin.wines.proposals.statusApproved')
                      : t('admin.wines.proposals.statusRejected')}
                  </span>
                )}
              </div>

              {p.kind === 'field_correction' && p.diff && Object.entries(p.diff).map(([field, d]) => (
                <div key={field} style={diffRowStyle}>
                  <span style={{ ...mutedStyle, minWidth: 90 }}>{t(FIELD_KEYS[field] || field)}</span>
                  <span style={{ textDecoration: 'line-through', ...mutedStyle }}>{d.current || '—'}</span>
                  <span aria-hidden="true">→</span>
                  <strong>{d.proposed}</strong>
                  {/* Drift: the wine changed since the somm looked at it — the
                      snapshot is what they judged, so flag the difference. */}
                  {p.currentSnapshot && p.currentSnapshot[field] !== d.current && (
                    <em style={{ ...mutedStyle, fontSize: '0.78rem' }}>
                      {t('admin.wines.proposals.drift', { value: p.currentSnapshot[field] || '—' })}
                    </em>
                  )}
                </div>
              ))}

              {p.kind === 'merge' && (
                <div style={diffRowStyle}>
                  <span style={mutedStyle}>{t('admin.wines.proposals.mergeInto')}</span>
                  {p.mergeTarget ? (
                    <Link to={`/wines/${p.mergeTarget._id}`} target="_blank" rel="noopener noreferrer">
                      <strong>{wineLabel(p.mergeTarget)}</strong>
                    </Link>
                  ) : (
                    <em style={mutedStyle}>{t('admin.wines.proposals.wineGone')}</em>
                  )}
                </div>
              )}

              {p.kind === 'non_wine' && (
                <div style={{ ...diffRowStyle, ...mutedStyle }}>
                  {t('admin.wines.proposals.nonWineLine')}
                </div>
              )}

              <div style={{ fontSize: '0.85rem', margin: '0.35rem 0' }}>
                {p.reason}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem', ...mutedStyle }}>
                {p.evidenceUrl && (
                  <a href={p.evidenceUrl} target="_blank" rel="noopener noreferrer">
                    {t('admin.wines.proposals.evidence')}
                  </a>
                )}
                <span>
                  {t('admin.wines.proposals.proposedBy', {
                    name: p.proposer?.username || '—',
                    date: new Date(p.createdAt).toLocaleDateString(),
                  })}
                </span>
                {p.status === 'approved' && p.appliedNote && <span>{p.appliedNote}</span>}
                {p.status === 'rejected' && p.rejectReason && (
                  <span>{t('admin.wines.proposals.rejectedWith', { reason: p.rejectReason })}</span>
                )}
              </div>

              {p.status === 'pending' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={!!pendingId}
                    onClick={() => approve(p)}
                    title={t('admin.wines.proposals.approveTitle')}
                  >
                    {pendingId === p._id && rejectingId !== p._id
                      ? t('admin.wines.proposals.approving')
                      : t('admin.wines.proposals.approve')}
                  </button>
                  {rejectingId === p._id ? (
                    <>
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder={t('admin.wines.proposals.rejectPlaceholder')}
                        maxLength={500}
                        disabled={!!pendingId}
                        style={{ flex: '1 1 220px', minWidth: 180 }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={!!pendingId}
                        onClick={() => reject(p)}
                      >
                        {pendingId === p._id
                          ? t('admin.wines.proposals.rejecting')
                          : t('admin.wines.proposals.rejectConfirm')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={!!pendingId}
                        onClick={() => { setRejectingId(null); setRejectReason(''); }}
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={!!pendingId}
                      onClick={() => { setRejectingId(p._id); setRejectReason(''); }}
                    >
                      {t('admin.wines.proposals.reject')}
                    </button>
                  )}
                </div>
              )}
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
    </Modal>
  );
}

export default WineProposalsModal;
