import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  getDiscussion, deleteDiscussion,
  getDiscussionReplies, createReply, updateReply, deleteReply,
  pinDiscussion, lockDiscussion, moveDiscussion,
  reportDiscussion, reportReply
} from '../api/discussions';
import CategoryBadge, { CATEGORY_LABELS } from '../components/CategoryBadge';
import ReplyCard from '../components/ReplyCard';
import WineReferenceCard from '../components/WineReferenceCard';
import WineSearchPicker from '../components/WineSearchPicker';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import CommunityCTA from '../components/CommunityCTA';
import SEOHead from '../components/SEOHead';
import DiscussionComposer from '../components/DiscussionComposer';
import { sanitizeForumRender } from '../utils/sanitizeForumRender';
import timeAgo from '../utils/timeAgo';
import './DiscussionDetail.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS);

function DiscussionDetail() {
  const { idOrSlug } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  // Once the discussion has loaded, prefer its canonical _id for write actions
  // — the URL might be a slug, but the API expects an ObjectId for writes.
  const id = idOrSlug;

  const [discussion, setDiscussion] = useState(null);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reply form
  const replyTextareaRef = useRef(null);
  const [replyBody, setReplyBody] = useState('');
  const [replyTextLength, setReplyTextLength] = useState(0);
  const [quoteData, setQuoteData] = useState(null); // { replyId, authorName, body }
  const [replyWine, setReplyWine] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [replyError, setReplyError] = useState(null);
  const REPLY_VISIBLE_MAX = 3000;

  // Edit reply
  const [editingReply, setEditingReply] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [editTextLength, setEditTextLength] = useState(0);

  // Report modal
  const [reportTarget, setReportTarget] = useState(null); // { type: 'discussion'|'reply', id }
  const [reportReason, setReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reporting, setReporting] = useState(false);

  // Confirm modals
  const [confirmDeleteReply, setConfirmDeleteReply] = useState(null); // reply object
  const [confirmDeleteDiscussion, setConfirmDeleteDiscussion] = useState(false);

  // Mod: move modal
  const [showMove, setShowMove] = useState(false);
  const [moveCategory, setMoveCategory] = useState('');

  const isOwner = user && discussion?.author?._id === user.id;
  const isMod = user && (user.roles?.includes('moderator') || user.roles?.includes('admin'));

  const fetchDiscussion = useCallback(async () => {
    try {
      const res = await getDiscussion(apiFetch, idOrSlug);
      const data = await res.json();
      if (res.ok) {
        setDiscussion(data.discussion);
        setError(null);
        // Canonicalise the URL: if the user landed on the ObjectId form but the
        // discussion has a slug, swap to the slug URL via history.replaceState
        // (no navigation, no extra render). Same trick WineDetail uses.
        if (data.discussion?.slug && data.discussion.slug !== idOrSlug) {
          window.history.replaceState({}, '', `/community/discussions/${data.discussion.slug}`);
        }
      } else {
        setError(data.error || t('discussions.failedLoadDiscussion'));
      }
    } catch {
      setError(t('discussions.failedLoadDiscussion'));
    }
  }, [apiFetch, idOrSlug, t]);

  const fetchReplies = useCallback(async (p, replace = false) => {
    try {
      if (replace) setLoading(true);
      else setLoadingMore(true);

      const res = await getDiscussionReplies(apiFetch, id, `page=${p}&limit=30`);
      const data = await res.json();

      if (res.ok) {
        setReplies(prev => replace ? data.replies : [...prev, ...data.replies]);
        setPage(p);
        setHasMore(p < data.pages);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [apiFetch, id]);

  useEffect(() => {
    fetchDiscussion();
    fetchReplies(1, true);
  }, [fetchDiscussion, fetchReplies]);

  const handleSubmitReply = async (e) => {
    e.preventDefault();
    if (replyTextLength < 1) return;

    setSubmitting(true);
    setReplyError(null);

    try {
      const payload = { body: replyBody };
      if (quoteData) {
        payload.quote = { replyId: quoteData.replyId };
      }
      if (replyWine) {
        payload.wineDefinition = replyWine._id;
      }
      const res = await createReply(apiFetch, id, payload);
      const data = await res.json();

      if (res.ok) {
        setReplies(prev => [...prev, { ...data.reply, liked: false }]);
        setReplyBody('');
        setReplyTextLength(0);
        setQuoteData(null);
        setReplyWine(null);
        // Update discussion reply count locally
        setDiscussion(prev => prev ? { ...prev, replyCount: prev.replyCount + 1 } : prev);
      } else {
        setReplyError(data.error || t('discussions.failedPostReply'));
      }
    } catch {
      setReplyError(t('discussions.failedPostReply'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditReply = async (e) => {
    e.preventDefault();
    if (editTextLength < 1 || !editingReply) return;

    try {
      const res = await updateReply(apiFetch, id, editingReply._id, { body: editBody });
      const data = await res.json();
      if (res.ok) {
        setReplies(prev => prev.map(r => r._id === editingReply._id ? { ...r, ...data.reply, liked: r.liked } : r));
        setEditingReply(null);
        setEditBody('');
      }
    } catch {
      // silent
    }
  };

  const handleDeleteReply = async (reply) => {
    try {
      const res = await deleteReply(apiFetch, id, reply._id);
      if (res.ok) {
        const data = await res.json();
        // Update reply in-place to show soft-deleted state
        setReplies(prev => prev.map(r => r._id === reply._id ? { ...r, ...data.reply, isDeleted: true, body: t('discussions.replyRemoved') } : r));
      }
    } catch {
      // silent
    } finally {
      setConfirmDeleteReply(null);
    }
  };

  const handleDeleteDiscussion = async () => {
    try {
      const res = await deleteDiscussion(apiFetch, id);
      if (res.ok) {
        navigate('/community/discussions');
      }
    } catch {
      // silent
    } finally {
      setConfirmDeleteDiscussion(false);
    }
  };

  const handlePin = async () => {
    try {
      const res = await pinDiscussion(apiFetch, id);
      const data = await res.json();
      if (res.ok) setDiscussion(data.discussion);
    } catch {
      // silent
    }
  };

  const handleLock = async () => {
    try {
      const res = await lockDiscussion(apiFetch, id);
      const data = await res.json();
      if (res.ok) setDiscussion(data.discussion);
    } catch {
      // silent
    }
  };

  const handleMove = async () => {
    if (!moveCategory) return;
    try {
      const res = await moveDiscussion(apiFetch, id, moveCategory);
      const data = await res.json();
      if (res.ok) {
        setDiscussion(data.discussion);
        setShowMove(false);
      }
    } catch {
      // silent
    }
  };

  const handleReport = async (e) => {
    e.preventDefault();
    if (!reportReason) return;
    setReporting(true);

    try {
      const data = { reason: reportReason, details: reportDetails || undefined };
      let res;
      if (reportTarget.type === 'discussion') {
        res = await reportDiscussion(apiFetch, reportTarget.id, data);
      } else {
        res = await reportReply(apiFetch, id, reportTarget.id, data);
      }
      if (res.ok) {
        setReportTarget(null);
        setReportReason('');
        setReportDetails('');
      }
    } catch {
      // silent
    } finally {
      setReporting(false);
    }
  };

  if (error) {
    return (
      <div className="discussion-detail">
        <div className="alert alert-error">{error}</div>
        <Link to="/community/discussions" className="btn btn-secondary">{t('discussions.backToDiscussions')}</Link>
      </div>
    );
  }

  if (!discussion || loading) {
    return <div className="discussion-detail"><p className="discussion-detail__loading">{t('common.loading')}</p></div>;
  }

  const author = discussion.author || {};
  const authorName = author.displayName || author.username || 'Unknown';

  const slugOrId = discussion.slug || discussion._id;
  const canonicalPath = `/community/discussions/${slugOrId}`;
  const seoDescription = (discussion.body || '').slice(0, 160);

  return (
    <div className="discussion-detail">
      <SEOHead
        title={`${discussion.title} — Cellarion`}
        description={seoDescription || `${discussion.title} — Cellarion wine discussion`}
        path={canonicalPath}
        ogType="article"
        articleMeta={{
          publishedTime: discussion.createdAt,
          modifiedTime: discussion.lastActivityAt || discussion.updatedAt
        }}
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'DiscussionForumPosting',
          headline: discussion.title,
          articleBody: discussion.body,
          datePublished: discussion.createdAt,
          dateModified: discussion.lastActivityAt || discussion.updatedAt,
          author: { '@type': 'Person', name: authorName },
          publisher: {
            '@type': 'Organization',
            name: 'Cellarion',
            url: 'https://cellarion.app'
          },
          interactionStatistic: {
            '@type': 'InteractionCounter',
            interactionType: 'https://schema.org/CommentAction',
            userInteractionCount: discussion.replyCount || 0
          }
        }}
      />
      <Link to="/community/discussions" className="discussion-detail__back">{t('discussions.backToDiscussions')}</Link>

      {/* Discussion header */}
      <div className="discussion-detail__header card">
        <div className="discussion-detail__meta">
          <CategoryBadge category={discussion.category} />
          {discussion.isPinned && <span className="discussion-card__pinned">{t('discussions.pinned')}</span>}
          {discussion.isLocked && <span className="discussion-card__locked">{t('discussions.locked')}</span>}
        </div>

        <h1 className="discussion-detail__title">{discussion.title}</h1>

        <div className="discussion-detail__author-line">
          <Link to={`/users/${author._id}`} className="discussion-detail__author-link">
            <span className="reply-card__avatar">{authorName.charAt(0).toUpperCase()}</span>
            <span>{authorName}</span>
          </Link>
          {author.roles?.includes('moderator') && <span className="badge badge--mod">{t('discussions.mod')}</span>}
          {author.roles?.includes('admin') && <span className="badge badge--admin">{t('discussions.admin')}</span>}
          <span className="discussion-detail__time">{timeAgo(discussion.createdAt)}</span>
          {discussion.replyCount > 0 && (
            <span className="discussion-detail__reply-count">{discussion.replyCount} {discussion.replyCount === 1 ? t('discussions.reply') : t('discussions.replies')}</span>
          )}
        </div>

        {discussion.wineDefinition && <WineReferenceCard wine={discussion.wineDefinition} />}

        <div
          className="discussion-detail__body discussion-body"
          dangerouslySetInnerHTML={{ __html: sanitizeForumRender(discussion.body) }}
        />

        <div className="discussion-detail__actions">
          {user && !isOwner && (
            <button className="reply-card__action-btn" onClick={() => setReportTarget({ type: 'discussion', id: discussion._id })}>
              {t('discussions.report')}
            </button>
          )}
          {isMod && (
            <>
              <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={() => setConfirmDeleteDiscussion(true)}>
                {t('common.delete')}
              </button>
              <button className="reply-card__action-btn" onClick={handlePin}>
                {discussion.isPinned ? t('discussions.unpin') : t('discussions.pin')}
              </button>
              <button className="reply-card__action-btn" onClick={handleLock}>
                {discussion.isLocked ? t('discussions.unlock') : t('discussions.lock')}
              </button>
              <button className="reply-card__action-btn" onClick={() => { setMoveCategory(discussion.category); setShowMove(true); }}>
                {t('discussions.move')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Replies */}
      <div className="discussion-detail__replies">
        <h2 className="discussion-detail__section-title">{t('discussions.repliesTitle')}</h2>
        {replies.length === 0 ? (
          <p className="discussion-detail__no-replies">{t('discussions.noReplies')}</p>
        ) : (
          replies.map(reply => (
            <ReplyCard
              key={reply._id}
              reply={reply}
              discussionId={id}
              onReply={!user || discussion.isLocked ? null : (r) => {
                const authorName = r.author?.displayName || r.author?.username || 'Unknown';
                // r.body is now HTML — strip to plain text for the quote
                // preview. The backend independently rebuilds the persisted
                // snapshot from the server-side body, so this is preview-only.
                const plain = String(r.body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                const snippet = plain.length > 300 ? plain.slice(0, 300) + '…' : plain;
                setQuoteData({ replyId: r._id, authorName, body: snippet });
                // Scroll the composer into view
                setTimeout(() => {
                  if (replyTextareaRef.current) {
                    replyTextareaRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }, 50);
              }}
              onEdit={user ? (r) => {
                setEditingReply(r);
                setEditBody(r.body);
                // Seed the visible-length counter so the Save button isn't
                // disabled before the user edits anything.
                const plain = String(r.body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                setEditTextLength(plain.length);
              } : null}
              onDelete={user ? (r) => setConfirmDeleteReply(r) : null}
              onReport={user ? (r) => setReportTarget({ type: 'reply', id: r._id }) : null}
            />
          ))
        )}

        {hasMore && (
          <div className="discussions__load-more">
            <button className="btn btn-secondary" onClick={() => fetchReplies(page + 1)} disabled={loadingMore}>
              {loadingMore ? t('common.loading') : t('discussions.loadMoreReplies')}
            </button>
          </div>
        )}
      </div>

      {/* Reply form — anon users see a sign-in CTA, logged-in users get the composer (unless locked) */}
      {!user ? (
        <CommunityCTA message={t('discussions.signInToReply')} />
      ) : !discussion.isLocked ? (
        <div className="discussion-detail__reply-form card">
          {replyError && <div className="alert alert-error">{replyError}</div>}
          {quoteData && (
            <div className="discussion-detail__quote-preview">
              <div className="discussion-detail__quote-preview-header">
                <span>{t('discussions.replyingTo')} <strong>{quoteData.authorName}</strong></span>
                <button type="button" className="discussion-detail__quote-remove" onClick={() => setQuoteData(null)}>&times;</button>
              </div>
              <div className="discussion-detail__quote-preview-body">{quoteData.body}</div>
            </div>
          )}
          <form onSubmit={handleSubmitReply}>
            <div ref={replyTextareaRef}>
              <DiscussionComposer
                value={replyBody}
                onChange={setReplyBody}
                onTextLengthChange={setReplyTextLength}
                placeholder={t('discussions.replyPlaceholder')}
                maxVisibleLength={REPLY_VISIBLE_MAX}
                minHeight={100}
              />
            </div>
            {replyWine ? (
              <div className="discussion-detail__reply-wine">
                <WineReferenceCard wine={replyWine} />
                <button type="button" className="discussion-detail__quote-remove" onClick={() => setReplyWine(null)}>&times;</button>
              </div>
            ) : (
              <details className="discussion-detail__wine-picker-toggle">
                <summary className="reply-card__action-btn">{t('discussions.linkWineShort')}</summary>
                <div className="discussion-detail__wine-picker">
                  <WineSearchPicker selected={null} onSelect={(w) => { if (w) setReplyWine(w); }} />
                </div>
              </details>
            )}
            <div className="discussion-detail__reply-actions">
              <button type="submit" className="btn btn-primary btn-small" disabled={submitting || replyTextLength < 1}>
                {submitting ? t('discussions.posting') : t('discussions.postReply')}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="discussion-detail__locked-notice card">
          {t('discussions.lockedNotice')}
        </div>
      )}

      {/* Edit reply modal */}
      {editingReply && (
        <Modal title={t('discussions.editReply')} onClose={() => setEditingReply(null)}>
          <form onSubmit={handleEditReply}>
            <DiscussionComposer
              value={editBody}
              onChange={setEditBody}
              onTextLengthChange={setEditTextLength}
              maxVisibleLength={REPLY_VISIBLE_MAX}
              minHeight={140}
            />
            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingReply(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={editTextLength < 1}>{t('common.save')}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Report modal */}
      {reportTarget && (
        <Modal title={reportTarget.type === 'discussion' ? t('discussions.reportDiscussion') : t('discussions.reportReply')} onClose={() => setReportTarget(null)}>
          <form onSubmit={handleReport} className="discussions__create-form">
            <div className="form-group">
              <label className="form-label">{t('discussions.reason')}</label>
              <select className="input" value={reportReason} onChange={e => setReportReason(e.target.value)} required>
                <option value="">{t('discussions.selectReason')}</option>
                <option value="spam">{t('discussions.spam')}</option>
                <option value="harassment">{t('discussions.harassment')}</option>
                <option value="off_topic">{t('discussions.offTopic')}</option>
                <option value="inappropriate">{t('discussions.inappropriate')}</option>
                <option value="other">{t('discussions.other')}</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('discussions.detailsOptional')}</label>
              <textarea
                className="input"
                value={reportDetails}
                onChange={e => setReportDetails(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder={t('discussions.detailsPlaceholder')}
              />
            </div>
            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setReportTarget(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={reporting || !reportReason}>
                {reporting ? t('discussions.submitting') : t('discussions.submitReport')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Move category modal */}
      {showMove && (
        <Modal title={t('discussions.moveDiscussion')} onClose={() => setShowMove(false)}>
          <div className="form-group">
            <label className="form-label">{t('discussions.newCategory')}</label>
            <select className="input" value={moveCategory} onChange={e => setMoveCategory(e.target.value)}>
              {CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
              ))}
            </select>
          </div>
          <div className="discussions__create-actions">
            <button className="btn btn-secondary" onClick={() => setShowMove(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleMove}>{t('discussions.move')}</button>
          </div>
        </Modal>
      )}

      {/* Confirm delete reply */}
      {confirmDeleteReply && (
        <ConfirmModal
          title={t('discussions.deleteReply')}
          message={t('discussions.confirmDeleteReply')}
          warning={t('discussions.deleteReplyWarning')}
          onConfirm={() => handleDeleteReply(confirmDeleteReply)}
          onCancel={() => setConfirmDeleteReply(null)}
        />
      )}

      {/* Confirm delete discussion */}
      {confirmDeleteDiscussion && (
        <ConfirmModal
          title={t('discussions.deleteDiscussion')}
          message={t('discussions.confirmDeleteDiscussion')}
          warning={t('discussions.deleteDiscussionWarning')}
          onConfirm={handleDeleteDiscussion}
          onCancel={() => setConfirmDeleteDiscussion(false)}
        />
      )}
    </div>
  );
}

export default DiscussionDetail;
