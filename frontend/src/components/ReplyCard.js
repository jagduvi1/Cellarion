import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { toggleReplyLike, getReplyOriginal, banUser } from '../api/discussions';
import WineReferenceCard from './WineReferenceCard';
import CellarCredBadge from './CellarCredBadge';
import timeAgo from '../utils/timeAgo';
import './ReplyCard.css';

function QuoteBlock({ quote }) {
  if (!quote || !quote.body) return null;
  return (
    <div className="reply-card__quote">
      <div className="reply-card__quote-author">{quote.authorName || 'Unknown'} wrote:</div>
      <div className="reply-card__quote-body">{quote.body}</div>
    </div>
  );
}

export default function ReplyCard({ reply, discussionId, onReply, onEdit, onDelete, onReport }) {
  const { apiFetch, user } = useAuth();
  const [liked, setLiked] = useState(reply.liked || false);
  const [likesCount, setLikesCount] = useState(reply.likesCount || 0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalBody, setOriginalBody] = useState(null);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const [showBanMenu, setShowBanMenu] = useState(false);

  const author = reply.author || {};
  const authorName = author.displayName || author.username || 'Unknown';
  const isOwn = user && author._id === user.id;
  const isMod = user && (user.roles?.includes('moderator') || user.roles?.includes('admin'));
  const authorIsMod = author.roles?.includes('moderator') || author.roles?.includes('admin');

  const handleBan = async (duration) => {
    const label = { '10m': '10 minutes', '1h': '1 hour', '1d': '1 day', '1w': '1 week', 'permanent': 'permanently' }[duration];
    if (!window.confirm(`Ban ${authorName} from discussions for ${label}?`)) return;
    try {
      const res = await banUser(apiFetch, author._id, duration);
      if (res.ok) {
        setShowBanMenu(false);
        window.alert(`${authorName} has been banned for ${label}`);
      }
    } catch {
      // silent
    }
  };

  const handleLike = async () => {
    const prevLiked = liked;
    const prevCount = likesCount;
    setLiked(!liked);
    setLikesCount(liked ? likesCount - 1 : likesCount + 1);

    try {
      const res = await toggleReplyLike(apiFetch, discussionId, reply._id);
      if (res.ok) {
        const data = await res.json();
        setLiked(data.liked);
        setLikesCount(data.likesCount);
      } else {
        setLiked(prevLiked);
        setLikesCount(prevCount);
      }
    } catch {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    }
  };

  const handleViewOriginal = async () => {
    if (originalBody !== null) {
      setShowOriginal(!showOriginal);
      return;
    }
    setLoadingOriginal(true);
    try {
      const res = await getReplyOriginal(apiFetch, discussionId, reply._id);
      if (res.ok) {
        const data = await res.json();
        setOriginalBody(data.originalBody);
        setShowOriginal(true);
      }
    } catch {
      // silent
    } finally {
      setLoadingOriginal(false);
    }
  };

  // Soft-deleted reply: show a muted placeholder
  if (reply.isDeleted) {
    return (
      <div className="reply-card reply-card--deleted">
        <div className="reply-card__header">
          <Link to={`/users/${author._id}`} className="reply-card__author">
            <span className="reply-card__avatar reply-card__avatar--deleted">?</span>
            <span className="reply-card__author-name">{authorName}</span>
          </Link>
          <span className="reply-card__time">{timeAgo(reply.createdAt)}</span>
          <span className="reply-card__deleted-badge">Removed</span>
        </div>

        <div className="reply-card__body reply-card__body--deleted">
          {showOriginal && originalBody ? originalBody : reply.body}
        </div>

        {isMod && (
          <div className="reply-card__footer">
            <button className="reply-card__action-btn" onClick={handleViewOriginal} disabled={loadingOriginal}>
              {loadingOriginal ? 'Loading...' : (showOriginal ? 'Hide Original' : 'View Original')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="reply-card">
      <div className="reply-card__header">
        <Link to={`/users/${author._id}`} className="reply-card__author">
          <span className="reply-card__avatar">
            {authorName.charAt(0).toUpperCase()}
          </span>
          <span className="reply-card__author-name">{authorName}</span>
        </Link>
        {author.roles?.includes('moderator') && <span className="badge badge--mod">Mod</span>}
        {author.roles?.includes('admin') && <span className="badge badge--admin">Admin</span>}
        <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} />
        <span className="reply-card__time">{timeAgo(reply.createdAt)}</span>
        {reply.updatedAt !== reply.createdAt && (
          <span className="reply-card__edited">(edited)</span>
        )}
      </div>

      {reply.quote?.body && <QuoteBlock quote={reply.quote} />}
      {reply.wineDefinition && <WineReferenceCard wine={reply.wineDefinition} />}
      <div className="reply-card__body">{reply.body}</div>

      <div className="reply-card__footer">
        <button
          className={`reply-card__like-btn ${liked ? 'liked' : ''}`}
          onClick={handleLike}
          disabled={isOwn}
          title={isOwn ? 'Cannot like your own reply' : (liked ? 'Unlike' : 'Like')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          {likesCount > 0 && <span>{likesCount}</span>}
        </button>

        {onReply && (
          <button className="reply-card__action-btn" onClick={() => onReply(reply)}>
            Reply
          </button>
        )}

        {isOwn && onEdit && (
          <button className="reply-card__action-btn" onClick={() => onEdit(reply)}>
            Edit
          </button>
        )}

        {(isOwn || isMod) && onDelete && (
          <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={() => onDelete(reply)}>
            Delete
          </button>
        )}

        {!isOwn && onReport && (
          <button className="reply-card__action-btn" onClick={() => onReport(reply)}>
            Report
          </button>
        )}

        {isMod && !isOwn && !authorIsMod && (
          <div className="reply-card__ban-wrapper">
            <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={() => setShowBanMenu(!showBanMenu)}>
              Ban
            </button>
            {showBanMenu && (
              <div className="reply-card__ban-menu">
                {[['10m', '10 min'], ['1h', '1 hour'], ['1d', '1 day'], ['1w', '1 week'], ['permanent', 'Permanent']].map(([val, label]) => (
                  <button key={val} className="reply-card__ban-option" onClick={() => handleBan(val)}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
