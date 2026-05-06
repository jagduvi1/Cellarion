import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { toggleReaction, getReplyOriginal, banUser } from '../api/discussions';
import WineReferenceCard from './WineReferenceCard';
import CellarCredBadge from './CellarCredBadge';
import ConfirmModal from './ConfirmModal';
import ReactionPicker, { REACTIONS, EMOJI_BY_KIND } from './ReactionPicker';
import { sanitizeForumRender } from '../utils/sanitizeForumRender';
import { isDeletedUser } from '../utils/deletedUser';
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
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  // Reactions: counts come from the server (`reply.reactions = { kind: count }`)
  // and the requester's own reactions come as `reply.myReactions = [kind]`.
  // We mirror both into local state for optimistic toggling.
  const [reactionCounts, setReactionCounts] = useState(reply.reactions || {});
  const [myReactions, setMyReactions] = useState(new Set(reply.myReactions || []));
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalBody, setOriginalBody] = useState(null);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const [showBanMenu, setShowBanMenu] = useState(false);
  const [confirmBan, setConfirmBan] = useState(null); // { duration, label }

  const author = reply.author || {};
  const authorDeleted = isDeletedUser(author);
  const authorName = authorDeleted
    ? t('common.deletedUser')
    : (author.displayName || author.username || 'Unknown');
  const isOwn = user && author._id === user.id;
  const isMod = user && (user.roles?.includes('moderator') || user.roles?.includes('admin'));
  const authorIsMod = !authorDeleted && (author.roles?.includes('moderator') || author.roles?.includes('admin'));

  const handleBan = async (duration, label) => {
    try {
      const res = await banUser(apiFetch, author._id, duration);
      if (res.ok) {
        setShowBanMenu(false);
      }
    } catch {
      // silent
    } finally {
      setConfirmBan(null);
    }
  };

  // Toggle a reaction kind. Optimistic: flip locally first, reconcile from
  // the server response. Self-reactions are allowed (Slack/Discord/GitHub
  // model — let authors react to their own posts).
  const handleReact = async (kind) => {
    const had = myReactions.has(kind);
    const nextMine = new Set(myReactions);
    if (had) nextMine.delete(kind); else nextMine.add(kind);
    setMyReactions(nextMine);
    setReactionCounts(prev => {
      const next = { ...prev };
      const cur = next[kind] || 0;
      const adjusted = had ? cur - 1 : cur + 1;
      if (adjusted <= 0) delete next[kind];
      else next[kind] = adjusted;
      return next;
    });

    try {
      const res = await toggleReaction(apiFetch, discussionId, reply._id, kind);
      if (res.ok) {
        const data = await res.json();
        // Reconcile authoritative counts; mirror the optimistic mine flip
        // (the server doesn't return myReactions on toggle — it's keyed off
        // the requester and we already know).
        setReactionCounts(data.reactions || {});
      } else {
        // Roll back optimistic update
        setMyReactions(myReactions);
        setReactionCounts(reactionCounts);
      }
    } catch {
      setMyReactions(myReactions);
      setReactionCounts(reactionCounts);
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
          {showOriginal && originalBody ? (
            // The mod-only "view original" shows the deletedBody, which is
            // sanitized HTML — render through the same allowlist as live replies.
            <div className="discussion-body" dangerouslySetInnerHTML={{ __html: sanitizeForumRender(originalBody) }} />
          ) : (
            reply.body
          )}
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
        {authorDeleted ? (
          <span className="reply-card__author reply-card__author--deleted">
            <span className="reply-card__avatar reply-card__avatar--deleted">?</span>
            <span className="reply-card__author-name">{authorName}</span>
          </span>
        ) : (
          <Link to={`/users/${author._id}`} className="reply-card__author">
            <span className="reply-card__avatar">
              {authorName.charAt(0).toUpperCase()}
            </span>
            <span className="reply-card__author-name">{authorName}</span>
          </Link>
        )}
        {!authorDeleted && author.roles?.includes('moderator') && <span className="badge badge--mod">Mod</span>}
        {!authorDeleted && author.roles?.includes('admin') && <span className="badge badge--admin">Admin</span>}
        {!authorDeleted && <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} />}
        <span className="reply-card__time">{timeAgo(reply.createdAt)}</span>
        {reply.updatedAt !== reply.createdAt && (
          <span className="reply-card__edited">(edited)</span>
        )}
      </div>

      {reply.quote?.body && <QuoteBlock quote={reply.quote} />}
      {reply.wineDefinition && <WineReferenceCard wine={reply.wineDefinition} />}
      <div
        className="reply-card__body discussion-body"
        dangerouslySetInnerHTML={{ __html: sanitizeForumRender(reply.body) }}
      />

      <div className="reply-card__footer">
        {/* Reaction chips: existing reactions ordered by the curated REACTIONS
            list (so the same kind always sits in the same slot). Logged-in
            users can click to toggle their own reaction; anon users see them
            as read-only. The picker "+" only renders when logged in. */}
        <div className="reply-card__reactions">
          {REACTIONS.filter(r => (reactionCounts[r.kind] || 0) > 0).map(r => {
            const count = reactionCounts[r.kind];
            const mine = myReactions.has(r.kind);
            return (
              <button
                key={r.kind}
                type="button"
                className={`reaction-chip ${mine ? 'is-mine' : ''}`}
                onClick={user ? () => handleReact(r.kind) : undefined}
                disabled={!user}
                title={t(r.labelKey)}
                aria-label={`${t(r.labelKey)} ${count}`}
              >
                <span className="reaction-chip__emoji" aria-hidden="true">{r.emoji}</span>
                <span className="reaction-chip__count">{count}</span>
              </button>
            );
          })}
          {user && <ReactionPicker onPick={handleReact} />}
        </div>

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

        {/* Self-reactions are allowed; reporting yourself is not. */}
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
                {[['10m', '10 minutes'], ['1h', '1 hour'], ['1d', '1 day'], ['1w', '1 week'], ['permanent', 'permanently']].map(([val, label]) => (
                  <button key={val} className="reply-card__ban-option" onClick={() => setConfirmBan({ duration: val, label })}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmBan && (
        <ConfirmModal
          title="Ban User"
          message={`Ban ${authorName} from discussions for ${confirmBan.label}?`}
          confirmLabel="Ban"
          confirmClass="btn btn-warning btn-small"
          onConfirm={() => handleBan(confirmBan.duration, confirmBan.label)}
          onCancel={() => setConfirmBan(null)}
        />
      )}
    </div>
  );
}
