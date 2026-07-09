import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  getModerationReports,
  resolveReport,
  deleteDiscussion,
  deleteReply,
  banUser
} from '../api/discussions';
import ConfirmModal from '../components/ConfirmModal';
import { authorDisplayName } from '../utils/deletedUser';
import './AdminModerationReports.css';

// Moderation queue for discussion/reply reports.
//
// Surfaces the existing moderation endpoints that were previously without a UI:
//   GET   /api/discussions/moderation/reports            — list reports by status
//   PATCH /api/discussions/moderation/reports/:reportId  — mark resolved / dismissed
//   POST  /api/discussions/moderation/ban                — ban the content author
// plus the mod-capable content deletes (DELETE discussion / reply).
//
// Accessible to moderators AND admins — mirrors the backend's
// requireModeratorOrAdmin (roles include 'moderator' or 'admin').

// Report reasons reuse the existing discussions.* report vocabulary.
const REASON_KEYS = {
  spam: 'discussions.spam',
  harassment: 'discussions.harassment',
  off_topic: 'discussions.offTopic',
  inappropriate: 'discussions.inappropriate',
  other: 'discussions.other'
};

// Backend GET only accepts these (invalid values fall back to 'pending'),
// so there is no "All" tab.
const STATUS_OPTIONS = ['pending', 'resolved', 'dismissed'];

// Must match BAN_DURATIONS in backend/src/routes/discussions.js
const BAN_DURATIONS = ['10m', '1h', '1d', '1w', 'permanent'];

const LIMIT = 20;

function AdminModerationReports() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);
  const [banDuration, setBanDuration] = useState('1d');

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT, status: statusFilter });
      const res = await getModerationReports(apiFetch, params.toString());
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || t('moderationReports.failedLoad'));
        return;
      }
      setReports(data.reports || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {
      setLoadError(t('moderationReports.networkError'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, statusFilter, t]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const openReport = (report) => {
    setSelected(report);
    setError(null);
    setSuccess(null);
    setConfirmDelete(false);
    setConfirmBan(false);
  };

  // The reported content: either the discussion itself or one of its replies.
  const targetInfo = (report) => {
    if (report.discussion) {
      return {
        type: 'discussion',
        preview: report.discussion.title,
        author: report.discussion.author,
        link: `/community/discussions/${report.discussion._id}`
      };
    }
    if (report.reply) {
      return {
        type: 'reply',
        preview: report.reply.body,
        author: report.reply.author,
        // reply.discussion is an unpopulated ObjectId in the list response
        link: report.reply.discussion ? `/community/discussions/${report.reply.discussion}` : null
      };
    }
    // Content deleted since the report was filed
    return { type: null, preview: null, author: null, link: null };
  };

  // PATCH — mark the report resolved or dismissed.
  const handleResolve = async (status) => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await resolveReport(apiFetch, selected._id, status);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('moderationReports.failedAction'));
        return;
      }
      setSuccess(status === 'resolved'
        ? t('moderationReports.successResolved')
        : t('moderationReports.successDismissed'));
      setSelected(prev => ({ ...prev, ...data.report, discussion: prev.discussion, reply: prev.reply, user: prev.user }));
      fetchReports();
    } catch {
      setError(t('moderationReports.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  // Delete the reported content. The backend also removes the associated
  // report(s), so the item disappears from the queue afterwards.
  const handleDeleteContent = async () => {
    const target = targetInfo(selected);
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = target.type === 'discussion'
        ? await deleteDiscussion(apiFetch, selected.discussion._id)
        : await deleteReply(apiFetch, selected.reply.discussion, selected.reply._id);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('moderationReports.failedAction'));
        return;
      }
      setSuccess(t('moderationReports.successDeleted'));
      setSelected(null);
      fetchReports();
    } catch {
      setError(t('moderationReports.networkError'));
    } finally {
      setSubmitting(false);
      setConfirmDelete(false);
    }
  };

  // Ban the author of the reported content. Leaves the report pending so the
  // moderator still explicitly resolves it.
  const handleBan = async () => {
    const target = targetInfo(selected);
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await banUser(apiFetch, target.author._id, banDuration);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('moderationReports.failedAction'));
        return;
      }
      setSuccess(t('moderationReports.successBanned'));
    } catch {
      setError(t('moderationReports.networkError'));
    } finally {
      setSubmitting(false);
      setConfirmBan(false);
    }
  };

  const selectedTarget = selected ? targetInfo(selected) : null;
  const selectedAuthorName = selectedTarget?.author
    ? authorDisplayName(selectedTarget.author, t, t('common.unknown'))
    : null;

  return (
    <div className="admin-moderation-reports">
      <h1>{t('moderationReports.title')}</h1>
      <p className="amr-intro">{t('moderationReports.intro')}</p>

      <div className="amr-filters">
        <div className="amr-tabs">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              className={statusFilter === s ? 'active' : ''}
              onClick={() => { setStatusFilter(s); setPage(1); setSelected(null); }}
            >
              {t(`moderationReports.status.${s}`)}
            </button>
          ))}
        </div>
        <span className="amr-count">{t('moderationReports.count', { count: total })}</span>
      </div>

      <div className="amr-layout">
        <div className="amr-list">
          {loading && <p className="amr-msg">{t('common.loading')}</p>}
          {!loading && loadError && <p className="amr-msg amr-error">{loadError}</p>}
          {!loading && !loadError && reports.length === 0 && (
            <p className="amr-msg">{t('moderationReports.empty')}</p>
          )}
          {!loading && !loadError && reports.map(report => {
            const target = targetInfo(report);
            return (
              <div
                key={report._id}
                className={`amr-item ${selected?._id === report._id ? 'selected' : ''}`}
                onClick={() => openReport(report)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && openReport(report)}
              >
                <div className="amr-item-top">
                  <span className={`amr-badge reason-${report.reason}`}>
                    {t(REASON_KEYS[report.reason] || 'discussions.other')}
                  </span>
                  <span className="amr-badge amr-badge-type">
                    {target.type === 'reply'
                      ? t('moderationReports.typeReply')
                      : t('moderationReports.typeDiscussion')}
                  </span>
                  <span className={`amr-badge status-${report.status}`}>
                    {t(`moderationReports.status.${report.status}`)}
                  </span>
                </div>
                <div className="amr-item-preview">
                  {target.preview || t('moderationReports.contentRemoved')}
                </div>
                <div className="amr-item-meta">
                  <span>{report.user?.displayName || report.user?.username || t('common.unknown')}</span>
                  <span>{new Date(report.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            );
          })}

          {pages > 1 && (
            <div className="amr-pagination">
              <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                {t('moderationReports.prev')}
              </button>
              <span>{page} / {pages}</span>
              <button disabled={page === pages} onClick={() => setPage(p => p + 1)}>
                {t('moderationReports.next')}
              </button>
            </div>
          )}
        </div>

        <div className="amr-detail">
          {!selected ? (
            <p className="amr-placeholder">{t('moderationReports.selectPrompt')}</p>
          ) : (
            <>
              <div className="amr-detail-header">
                <h2>
                  {selectedTarget.type === 'reply'
                    ? t('moderationReports.typeReply')
                    : t('moderationReports.typeDiscussion')}
                </h2>
                <div className="amr-detail-badges">
                  <span className={`amr-badge reason-${selected.reason}`}>
                    {t(REASON_KEYS[selected.reason] || 'discussions.other')}
                  </span>
                  <span className={`amr-badge status-${selected.status}`}>
                    {t(`moderationReports.status.${selected.status}`)}
                  </span>
                </div>
              </div>

              <div className="amr-detail-meta">
                <span>
                  {t('moderationReports.reportedBy')}{' '}
                  <strong>{selected.user?.displayName || selected.user?.username || t('common.unknown')}</strong>
                </span>
                <span>{new Date(selected.createdAt).toLocaleDateString()}</span>
              </div>

              <div className="amr-section">
                <h4>{t('moderationReports.reportedContent')}</h4>
                {selectedTarget.preview ? (
                  <p className="amr-content-preview">{selectedTarget.preview}</p>
                ) : (
                  <p className="amr-content-removed">{t('moderationReports.contentRemoved')}</p>
                )}
                {selectedAuthorName && (
                  <p className="amr-content-author">
                    {t('moderationReports.author')}: <strong>{selectedAuthorName}</strong>
                  </p>
                )}
                {selectedTarget.link && (
                  <Link to={selectedTarget.link} className="amr-thread-link">
                    {t('moderationReports.viewThread')} →
                  </Link>
                )}
              </div>

              {selected.details && (
                <div className="amr-section">
                  <h4>{t('moderationReports.details')}</h4>
                  <p className="amr-content-preview">{selected.details}</p>
                </div>
              )}

              {selected.status === 'pending' && (
                <div className="amr-actions">
                  <h4>{t('moderationReports.actions')}</h4>
                  <div className="amr-action-buttons">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={() => handleResolve('resolved')}
                      disabled={submitting}
                    >
                      {t('moderationReports.markResolved')}
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => handleResolve('dismissed')}
                      disabled={submitting}
                    >
                      {t('moderationReports.dismiss')}
                    </button>
                    {selectedTarget.preview && (
                      <button
                        className="btn btn-danger btn-small"
                        onClick={() => setConfirmDelete(true)}
                        disabled={submitting}
                      >
                        {t('moderationReports.deleteContent')}
                      </button>
                    )}
                  </div>

                  {selectedTarget.author?._id && (
                    <div className="amr-ban-row">
                      <label htmlFor="amr-ban-duration">{t('moderationReports.banDurationLabel')}</label>
                      <select
                        id="amr-ban-duration"
                        value={banDuration}
                        onChange={e => setBanDuration(e.target.value)}
                        disabled={submitting}
                      >
                        {BAN_DURATIONS.map(d => (
                          <option key={d} value={d}>{t(`discussions.banDuration.${d}`)}</option>
                        ))}
                      </select>
                      <button
                        className="btn btn-warning btn-small"
                        onClick={() => setConfirmBan(true)}
                        disabled={submitting}
                      >
                        {t('moderationReports.banAuthor')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {selected.status !== 'pending' && selected.resolvedAt && (
                <p className="amr-resolved-info">
                  {t('moderationReports.handledOn', {
                    date: new Date(selected.resolvedAt).toLocaleDateString()
                  })}
                </p>
              )}

              {error && <p className="amr-error">{error}</p>}
              {success && <p className="amr-success">{success}</p>}
            </>
          )}
        </div>
      </div>

      {confirmDelete && selected && (
        <ConfirmModal
          title={t('moderationReports.deleteContentTitle')}
          message={selectedTarget.type === 'discussion'
            ? t('moderationReports.deleteDiscussionConfirm')
            : t('moderationReports.deleteReplyConfirm')}
          warning={t('moderationReports.deleteWarning')}
          confirmLabel={t('moderationReports.deleteContent')}
          onConfirm={handleDeleteContent}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {confirmBan && selected && selectedTarget.author?._id && (
        <ConfirmModal
          title={t('discussions.banUserTitle')}
          message={t('discussions.confirmBan', {
            name: selectedAuthorName,
            duration: t(`discussions.banDuration.${banDuration}`)
          })}
          confirmLabel={t('moderationReports.banAuthor')}
          confirmClass="btn btn-warning btn-small"
          onConfirm={handleBan}
          onCancel={() => setConfirmBan(false)}
        />
      )}
    </div>
  );
}

export default AdminModerationReports;
