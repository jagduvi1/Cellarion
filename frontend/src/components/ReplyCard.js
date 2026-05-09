import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { toggleReaction, getReplyOriginal, banUser } from '../api/discussions';
import WineReferenceCard from './WineReferenceCard';
import CellarCredBadge from './CellarCredBadge';
import ConfirmModal from './ConfirmModal';
import ReactionPicker, { REACTIONS } from './ReactionPicker';
import { sanitizeForumRender } from '../utils/sanitizeForumRender';
import { isDeletedUser, authorDisplayName } from '../utils/deletedUser';
import timeAgo from '../utils/timeAgo';
import './ReplyCard.css';

function QuoteBlock({ quote }) {
  const { t } = useTranslation();
  if (!quote || !quote.body) return null;
  return (
    <div className="reply-card__quote">
      <div className="reply-card__quote-author">
        {t('discussions.quoteAttribution', { name: quote.authorName || t('common.unknown') })}
      </div>
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
  // Monotonic counter for in-flight reaction toggles. Used to discard
  // rollbacks from older requests when the user has already fired a newer
  // toggle — without this, a slow first-click failure can stomp on the
  // already-applied second click.
  const reactionRequestRef = useRef(0);

  const author = reply.author || {};
  const authorDeleted = isDeletedUser(author);
  const authorName = authorDisplayName(author, t, t('common.unknown'));
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
  //
  // Rapid double-click safety: a per-toggle token guards rollback paths so a
  // slow earlier-failed call can't undo an already-applied later call. The
  // server is the single source of truth; only the *latest* response wins.
  const handleReact = async (kind) => {
    const token = ++reactionRequestRef.current;
    const prevMine = myReactions;
    const prevCounts = reactionCounts;
    const had = prevMine.has(kind);
    const nextMine = new Set(prevMine);
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
      if (token !== reactionRequestRef.current) return; // a newer toggle owns state
      if (res.ok) {
        const data = await res.json();
        // Reconcile authoritative counts; mirror the optimistic mine flip
        // (the server doesn't return myReactions on toggle — it's keyed off
        // the requester and we already know).
        setReactionCounts(data.reactions || {});
      } else {
        setMyReactions(prevMine);
        setReactionCounts(prevCounts);
      }
    } catch {
      if (token !== reactionRequestRef.current) return;
      setMyReactions(prevMine);
      setReactionCounts(prevCounts);
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
          <span className="reply-card__deleted-badge">{t('discussions.removed')}</span>
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
              {loadingOriginal ? t('common.loading') : (showOriginal ? t('discussions.hideOriginal') : t('discussions.viewOriginal'))}
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
        {!authorDeleted && author.roles?.includes('moderator') && <span className="badge badge--mod">{t('discussions.mod')}</span>}
        {!authorDeleted && author.roles?.includes('admin') && <span className="badge badge--admin">{t('discussions.admin')}</span>}
        {!authorDeleted && <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} />}
        <span className="reply-card__time">{timeAgo(reply.createdAt)}</span>
        {reply.updatedAt !== reply.createdAt && (
          <span className="reply-card__edited">{t('discussions.editedSuffix')}</span>
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
            {t('discussions.replyShort')}
          </button>
        )}

        {isOwn && onEdit && (
          <button className="reply-card__action-btn" onClick={() => onEdit(reply)}>
            {t('common.edit')}
          </button>
        )}

        {(isOwn || isMod) && onDelete && (
          <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={() => onDelete(reply)}>
            {t('common.delete')}
          </button>
        )}

        {/* Self-reactions are allowed; reporting yourself is not. */}
        {!isOwn && onReport && (
          <button className="reply-card__action-btn" onClick={() => onReport(reply)}>
            {t('discussions.report')}
          </button>
        )}

        {isMod && !isOwn && !authorIsMod && (
          <div className="reply-card__ban-wrapper">
            <button className="reply-card__action-btn reply-card__action-btn--danger" onClick={() => setShowBanMenu(!showBanMenu)}>
              {t('discussions.ban')}
            </button>
            {showBanMenu && (
              <div className="reply-card__ban-menu">
                {[
                  ['10m', t('discussions.banDuration.10m')],
                  ['1h', t('discussions.banDuration.1h')],
                  ['1d', t('discussions.banDuration.1d')],
                  ['1w', t('discussions.banDuration.1w')],
                  ['permanent', t('discussions.banDuration.permanent')]
                ].map(([val, label]) => (
                  <button key={val} className="reply-card__ban-option" onClick={() => setConfirmBan({ duration: val, label })}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmBan && (
        <ConfirmModal
          title={t('discussions.banUserTitle')}
          message={t('discussions.confirmBan', { name: authorName, duration: confirmBan.label })}
          confirmLabel={t('discussions.ban')}
          confirmClass="btn btn-warning btn-small"
          onConfirm={() => handleBan(confirmBan.duration, confirmBan.label)}
          onCancel={() => setConfirmBan(null)}
        />
      )}
    </div>
  );
}
