import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
import './DiscussionDetail.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS);

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function DiscussionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { apiFetch, user } = useAuth();

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
  const [quoteData, setQuoteData] = useState(null); // { replyId, authorName, body }
  const [replyWine, setReplyWine] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [replyError, setReplyError] = useState(null);

  // Edit reply
  const [editingReply, setEditingReply] = useState(null);
  const [editBody, setEditBody] = useState('');

  // Report modal
  const [reportTarget, setReportTarget] = useState(null); // { type: 'discussion'|'reply', id }
  const [reportReason, setReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reporting, setReporting] = useState(false);

  // Mod: move modal
  const [showMove, setShowMove] = useState(false);
  const [moveCategory, setMoveCategory] = useState('');

  const isOwner = user && discussion?.author?._id === user.id;
  const isMod = user && (user.roles?.includes('moderator') || user.roles?.includes('admin'));

  const fetchDiscussion = useCallback(async () => {
    try {
      const res = await getDiscussion(apiFetch, id);
      const data = await res.json();
      if (res.ok) {
        setDiscussion(data.discussion);
        setError(null);
      } else {
        setError(data.error || 'Discussion not found');
      }
    } catch {
      setError('Failed to load discussion');
    }
  }, [apiFetch, id]);

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
    if (!replyBody.trim()) return;

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
        setQuoteData(null);
        setReplyWine(null);
        // Update discussion reply count locally
        setDiscussion(prev => prev ? { ...prev, replyCount: prev.replyCount + 1 } : prev);
      } else {
        setReplyError(data.error || 'Failed to post reply');
      }
    } catch {
      setReplyError('Failed to post reply');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditReply = async (e) => {
    e.preventDefault();
    if (!editBody.trim() || !editingReply) return;

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
    if (!window.confirm('Delete this reply? The text will be hidden but moderators can still review it.')) return;
    try {
      const res = await deleteReply(apiFetch, id, reply._id);
      if (res.ok) {
        const data = await res.json();
        // Update reply in-place to show soft-deleted state
        setReplies(prev => prev.map(r => r._id === reply._id ? { ...r, ...data.reply, isDeleted: true, body: '[This reply has been removed]' } : r));
      }
    } catch {
      // silent
    }
  };

  const handleDeleteDiscussion = async () => {
    if (!window.confirm('Delete this discussion and all its replies?')) return;
    try {
      const res = await deleteDiscussion(apiFetch, id);
      if (res.ok) {
        navigate('/community/discussions');
      }
    } catch {
      // silent
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
        <Link to="/community/discussions" className="btn btn-secondary">Back to Discussions</Link>
      </div>
    );
  }

  if (!discussion || loading) {
    return <div className="discussion-detail"><p className="discussion-detail__loading">Loading...</p></div>;
  }

  const author = discussion.author || {};
  const authorName = author.displayName || author.username || 'Unknown';

  return (
    <div className="discussion-detail">
      <Link to="/community/discussions" className="discussion-detail__back">Back to Discussions</Link>

      {/* Discussion header */}
      <div className="discussion-detail__header card">
        <div className="discussion-detail__meta">
          <CategoryBadge category={discussion.category} />
          {discussion.isPinned && <span className="discussion-card__pinned">Pinned</span>}
          {discussion.isLocked && <span className="discussion-card__locked">Locked</span>}
        </div>

        <h1 className="discussion-detail__title">{discussion.title}</h1>

        <div className="discussion-detail__author-line">
          <Link to={`/users/${author._id}`} className="discussion-detail__author-link">
            <span className="reply-card__avatar">{authorName.charAt(0).toUpperCase()}</span>
            <span>{authorName}</span>
          </Link>
          {author.roles?.includes('moderator') && <span className="badge badge--mod">Mod</span>}
          {author.roles?.includes('admin') && <span className="badge badge--admin">Admin</span>}
          <span className="discussion-detail__time">{timeAgo(discussion.createdAt)}</span>
          {discussion.replyCount > 0 && (
            <span className="discussion-detail__reply-count">{discussion.replyCount} {discussion.replyCount === 1 ? 'reply' : 'replies'}</span>
          )}
        </div>

        {discussion.wineDefinition && <WineReferenceCard wine={discussion.wineDefinition} />}

        <div className="discussion-detail__body">{discussion.body}</div>

        <div className="discussion-detail__actions">
          {!isOwner && (
            <button className="reply-card__action-btn" onClick={() => setReportTarget({ type: 'discussion', id: discussion._id })}>
              Report
            </button>
          )}
          {isMod && (
            <>
              <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={handleDeleteDiscussion}>
                Delete
              </button>
              <button className="reply-card__action-btn" onClick={handlePin}>
                {discussion.isPinned ? 'Unpin' : 'Pin'}
              </button>
              <button className="reply-card__action-btn" onClick={handleLock}>
                {discussion.isLocked ? 'Unlock' : 'Lock'}
              </button>
              <button className="reply-card__action-btn" onClick={() => { setMoveCategory(discussion.category); setShowMove(true); }}>
                Move
              </button>
            </>
          )}
        </div>
      </div>

      {/* Replies */}
      <div className="discussion-detail__replies">
        <h2 className="discussion-detail__section-title">Replies</h2>
        {replies.length === 0 ? (
          <p className="discussion-detail__no-replies">No replies yet. Be the first to respond!</p>
        ) : (
          replies.map(reply => (
            <ReplyCard
              key={reply._id}
              reply={reply}
              discussionId={id}
              onReply={discussion.isLocked ? null : (r) => {
                const authorName = r.author?.displayName || r.author?.username || 'Unknown';
                const snippet = r.body.length > 300 ? r.body.slice(0, 300) + '…' : r.body;
                setQuoteData({ replyId: r._id, authorName, body: snippet });
                // Scroll to and focus the textarea
                setTimeout(() => {
                  if (replyTextareaRef.current) {
                    replyTextareaRef.current.focus();
                    replyTextareaRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }, 50);
              }}
              onEdit={(r) => { setEditingReply(r); setEditBody(r.body); }}
              onDelete={handleDeleteReply}
              onReport={(r) => setReportTarget({ type: 'reply', id: r._id })}
            />
          ))
        )}

        {hasMore && (
          <div className="discussions__load-more">
            <button className="btn btn-secondary" onClick={() => fetchReplies(page + 1)} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load More Replies'}
            </button>
          </div>
        )}
      </div>

      {/* Reply form */}
      {!discussion.isLocked ? (
        <div className="discussion-detail__reply-form card">
          {replyError && <div className="alert alert-error">{replyError}</div>}
          {quoteData && (
            <div className="discussion-detail__quote-preview">
              <div className="discussion-detail__quote-preview-header">
                <span>Replying to <strong>{quoteData.authorName}</strong></span>
                <button type="button" className="discussion-detail__quote-remove" onClick={() => setQuoteData(null)}>&times;</button>
              </div>
              <div className="discussion-detail__quote-preview-body">{quoteData.body}</div>
            </div>
          )}
          <form onSubmit={handleSubmitReply}>
            <textarea
              ref={replyTextareaRef}
              className="input discussion-detail__reply-textarea"
              value={replyBody}
              onChange={e => setReplyBody(e.target.value)}
              placeholder="Write a reply..."
              rows={3}
              maxLength={3000}
              required
            />
            {replyWine ? (
              <div className="discussion-detail__reply-wine">
                <WineReferenceCard wine={replyWine} />
                <button type="button" className="discussion-detail__quote-remove" onClick={() => setReplyWine(null)}>&times;</button>
              </div>
            ) : (
              <details className="discussion-detail__wine-picker-toggle">
                <summary className="reply-card__action-btn">Link a Wine</summary>
                <div className="discussion-detail__wine-picker">
                  <WineSearchPicker selected={null} onSelect={(w) => { if (w) setReplyWine(w); }} />
                </div>
              </details>
            )}
            <div className="discussion-detail__reply-actions">
              <span className="form-hint">{replyBody.length} / 3000</span>
              <button type="submit" className="btn btn-primary btn-small" disabled={submitting || !replyBody.trim()}>
                {submitting ? 'Posting...' : 'Post Reply'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="discussion-detail__locked-notice card">
          This discussion is locked. No new replies can be posted.
        </div>
      )}

      {/* Edit reply modal */}
      {editingReply && (
        <Modal title="Edit Reply" onClose={() => setEditingReply(null)}>
          <form onSubmit={handleEditReply}>
            <textarea
              className="input discussion-detail__reply-textarea"
              value={editBody}
              onChange={e => setEditBody(e.target.value)}
              rows={4}
              maxLength={3000}
              required
            />
            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditingReply(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!editBody.trim()}>Save</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Report modal */}
      {reportTarget && (
        <Modal title={`Report ${reportTarget.type === 'discussion' ? 'Discussion' : 'Reply'}`} onClose={() => setReportTarget(null)}>
          <form onSubmit={handleReport} className="discussions__create-form">
            <div className="form-group">
              <label className="form-label">Reason</label>
              <select className="input" value={reportReason} onChange={e => setReportReason(e.target.value)} required>
                <option value="">Select a reason...</option>
                <option value="spam">Spam</option>
                <option value="harassment">Harassment</option>
                <option value="off_topic">Off Topic</option>
                <option value="inappropriate">Inappropriate</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Details (optional)</label>
              <textarea
                className="input"
                value={reportDetails}
                onChange={e => setReportDetails(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Provide additional context..."
              />
            </div>
            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setReportTarget(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={reporting || !reportReason}>
                {reporting ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Move category modal */}
      {showMove && (
        <Modal title="Move Discussion" onClose={() => setShowMove(false)}>
          <div className="form-group">
            <label className="form-label">New Category</label>
            <select className="input" value={moveCategory} onChange={e => setMoveCategory(e.target.value)}>
              {CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
              ))}
            </select>
          </div>
          <div className="discussions__create-actions">
            <button className="btn btn-secondary" onClick={() => setShowMove(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleMove}>Move</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default DiscussionDetail;
