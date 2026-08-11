import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { adminGetOwnerInquiries, adminResolveOwnerInquiry } from '../api/admin';

const PAGE_SIZE = 20;

const wineLabel = (w) => (w ? [w.producer, w.name].filter(Boolean).join(' — ') : null);

const STATUS_KEYS = {
  open: 'admin.wines.ownerInquiries.statusOpen',
  answered: 'admin.wines.ownerInquiries.statusAnswered',
  resolved: 'admin.wines.ownerInquiries.statusResolved',
  closed: 'admin.wines.ownerInquiries.statusClosed',
};

/**
 * Admin review queue for OWNER INQUIRIES — curator questions sent to a wine's
 * bottle owners (asked here or over MCP via ask_bottle_owner), with the
 * owners' answers inline. Resolving records what was done with the answers;
 * the registry fix itself happens through the normal edit/merge/proposal
 * tools. This is the ONE surface where recipient identities (emails) show —
 * admin-gated; the somm MCP list and the owners' own views are anonymised.
 *
 * Interlocks follow WineProposalsModal exactly: functional state updaters,
 * every action + pagination + view switch disabled while a POST is pending,
 * and the offset-drain pagination for rows this session resolved out of the
 * active view.
 *
 * Props: apiFetch (from useAuth()), onClose(), onChanged?() — fired after any
 * resolve so the opener can refresh its badge.
 */
function OwnerInquiriesModal({ apiFetch, onClose, onChanged }) {
  const { t } = useTranslation();
  const [statusView, setStatusView] = useState('active'); // 'active' | 'decided'
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [pendingCount, setPendingCount] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null); // inquiry id with a POST in flight
  const [resolvingId, setResolvingId] = useState(null); // row showing the inline note input
  const [resolveNote, setResolveNote] = useState('');
  const fetchGen = useRef(0);
  // Rows this session resolved leave the active view — subtract what we
  // removed from the fixed page*limit offset (the proposals drain pattern).
  const decidedDelta = useRef(0);

  const fetchPage = useCallback(async (p) => {
    const gen = ++fetchGen.current;
    setLoading(true);
    setError(null);
    try {
      const drained = statusView === 'active' ? decidedDelta.current : 0;
      const offset = Math.max(0, (p - 1) * PAGE_SIZE - drained);
      const params = new URLSearchParams({ status: statusView, offset, limit: PAGE_SIZE });
      const res = await adminGetOwnerInquiries(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (gen !== fetchGen.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(data.error || t('admin.wines.ownerInquiries.loadError'));
        return;
      }
      setItems(data.inquiries || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setPendingCount(data.pendingCount || 0);
      setAnsweredCount(data.answeredCount || 0);
    } catch {
      if (gen === fetchGen.current) setError(t('common.networkError'));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  }, [apiFetch, statusView, t]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const switchView = (v) => {
    if (v === statusView || pendingId) return;
    decidedDelta.current = 0;
    setStatusView(v);
    setItems(null);
    setResolvingId(null);
    setResolveNote('');
    setPage(1);
  };

  // Post-resolve bookkeeping for the active view: drop the row via functional
  // updaters and refill the page when it drained empty.
  const removeResolvedRow = (inquiry) => {
    decidedDelta.current += 1;
    setItems(prev => (prev || []).filter(x => x._id !== inquiry._id));
    setTotal(prev => Math.max(0, prev - 1));
    setPendingCount(prev => Math.max(0, prev - 1));
    if (inquiry.status === 'answered') setAnsweredCount(prev => Math.max(0, prev - 1));
    const remaining = (items || []).filter(x => x._id !== inquiry._id).length;
    if (remaining === 0 && total - 1 > 0) {
      if (page > 1) setPage(p => p - 1);
      else fetchPage(1);
    }
  };

  const resolve = async (inquiry) => {
    const note = resolveNote.trim();
    if (note.length < 5) {
      setError(t('admin.wines.ownerInquiries.resolveNoteRequired'));
      return;
    }
    setPendingId(inquiry._id);
    setError(null);
    try {
      const res = await adminResolveOwnerInquiry(apiFetch, inquiry._id, note);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResolvingId(null);
        setResolveNote('');
        removeResolvedRow(inquiry);
        onChanged?.();
      } else {
        setError(data.error || t('admin.wines.ownerInquiries.resolveError'));
        // 409: another admin resolved it (or it closed) first — refresh so
        // the stale row leaves the list instead of inviting a second click.
        if (res.status === 409) fetchPage(page);
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
  const decidedBadgeStyle = {
    ...badgeStyle, background: 'var(--color-surface, #f4f4f4)', border: '1px solid var(--color-border)',
  };
  const boxStyle = {
    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
    padding: '0.65rem 0.85rem',
  };
  const mutedStyle = { color: 'var(--color-text-muted)' };
  const responseStyle = {
    margin: '0.25rem 0 0', padding: '0.35rem 0.6rem', fontSize: '0.85rem',
    background: 'var(--color-surface, rgba(0,0,0,0.04))', borderRadius: 'var(--radius-sm)',
  };

  return (
    <Modal title={t('admin.wines.ownerInquiries.title')} onClose={onClose} wide>
      <p style={{ ...mutedStyle, fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.wines.ownerInquiries.explainer')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={`btn ${statusView === 'active' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('active')}
        >
          {t('admin.wines.ownerInquiries.viewActive', { count: pendingCount })}
        </button>
        <button
          type="button"
          className={`btn ${statusView === 'decided' ? 'btn-primary' : 'btn-secondary'} btn-small`}
          disabled={!!pendingId}
          onClick={() => switchView('decided')}
        >
          {t('admin.wines.ownerInquiries.viewDecided')}
        </button>
        {statusView === 'active' && answeredCount > 0 && (
          <span style={{ ...badgeStyle }}>
            {t('admin.wines.ownerInquiries.answeredBadge', { count: answeredCount })}
          </span>
        )}
        {items !== null && !loading && (
          <span style={{ fontSize: '0.85rem', marginLeft: 'auto' }}>
            {t('admin.wines.ownerInquiries.count', { count: total })}
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading || items === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>
            {statusView === 'active'
              ? t('admin.wines.ownerInquiries.emptyActive')
              : t('admin.wines.ownerInquiries.emptyDecided')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map(i => (
            <div key={i._id} style={boxStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={i.status === 'open' || i.status === 'answered' ? badgeStyle : decidedBadgeStyle}>
                  {t(STATUS_KEYS[i.status] || STATUS_KEYS.open)}
                </span>
                {i.wineDefinition ? (
                  <Link to={`/wines/${i.wineDefinition._id}`} target="_blank" rel="noopener noreferrer">
                    <strong>{wineLabel(i.wineDefinition)}</strong>
                  </Link>
                ) : (
                  <strong style={mutedStyle}>{t('admin.wines.ownerInquiries.wineGone')}</strong>
                )}
                <span style={{ ...mutedStyle, fontSize: '0.8rem' }}>
                  {t('admin.wines.ownerInquiries.responses', { answered: i.responseCount, count: i.recipientCount })}
                </span>
              </div>

              <div style={{ fontSize: '0.9rem', margin: '0.2rem 0 0.5rem' }}>{i.question}</div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                {(i.recipients || []).map((r, idx) => (
                  <div key={idx} style={{ fontSize: '0.82rem' }}>
                    <span style={{ fontWeight: 600 }}>
                      {r.user ? (r.user.username || r.user.email) : t('admin.wines.ownerInquiries.recipientGone')}
                    </span>
                    {r.user?.email && <span style={{ ...mutedStyle }}> · {r.user.email}</span>}
                    {r.response ? (
                      <div style={responseStyle}>{r.response}</div>
                    ) : (
                      <span style={{ ...mutedStyle }}> — {t('admin.wines.ownerInquiries.noAnswerYet')}</span>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem', ...mutedStyle }}>
                <span>
                  {t('admin.wines.ownerInquiries.askedBy', {
                    name: i.askedBy?.username || '—',
                    date: new Date(i.createdAt).toLocaleDateString(),
                  })}
                </span>
                {i.askedVia === 'mcp' && <span>{t('admin.wines.ownerInquiries.viaMcp')}</span>}
                {(i.status === 'resolved' || i.status === 'closed') && i.resolutionNote && (
                  <span>{t('admin.wines.ownerInquiries.resolvedWith', { note: i.resolutionNote })}</span>
                )}
              </div>

              {(i.status === 'open' || i.status === 'answered') && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {resolvingId === i._id ? (
                    <>
                      <input
                        type="text"
                        value={resolveNote}
                        onChange={(e) => setResolveNote(e.target.value)}
                        placeholder={t('admin.wines.ownerInquiries.resolvePlaceholder')}
                        maxLength={500}
                        disabled={!!pendingId}
                        style={{ flex: '1 1 220px', minWidth: 180 }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={!!pendingId}
                        onClick={() => resolve(i)}
                      >
                        {pendingId === i._id
                          ? t('admin.wines.ownerInquiries.resolving')
                          : t('admin.wines.ownerInquiries.resolveConfirm')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={!!pendingId}
                        onClick={() => { setResolvingId(null); setResolveNote(''); }}
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={!!pendingId}
                      title={t('admin.wines.ownerInquiries.resolveTitle')}
                      onClick={() => { setResolvingId(i._id); setResolveNote(''); }}
                    >
                      {t('admin.wines.ownerInquiries.resolve')}
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

export default OwnerInquiriesModal;
