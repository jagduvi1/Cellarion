import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import CategoryBadge from './CategoryBadge';
import CellarCredBadge from './CellarCredBadge';
import { extractForumPlainText } from '../utils/sanitizeForumRender';
import { isDeletedUser, authorDisplayName } from '../utils/deletedUser';
import timeAgo from '../utils/timeAgo';
import './DiscussionCard.css';

// Two-column list row: title + body preview + OP author on the left,
// last-poster + reply count + time on the right. Pinned threads get a
// distinct treatment via data-pinned (CSS-only). Deleted authors render
// as a non-clickable "[Deleted user]" label without badges.
export default function DiscussionCard({ discussion }) {
  const { t } = useTranslation();
  const author = discussion.author || {};
  const authorIsDeleted = isDeletedUser(author);
  const authorName = authorDisplayName(author, t, t('common.unknown'));

  const bodyPlain = extractForumPlainText(discussion.body);
  const preview = bodyPlain.length > 140 ? bodyPlain.slice(0, 140) + '…' : bodyPlain;

  // Last-reply chip: who-said-what-most-recently. Falls back to OP for
  // threads with no replies (the OP is the most-recent activity by default).
  const lastReply = discussion.lastReply;
  const lastPoster = lastReply?.author || author;
  const lastPosterIsDeleted = isDeletedUser(lastPoster);
  const lastPosterName = authorDisplayName(lastPoster, t, t('common.unknown'));
  const lastPosterInitial = lastPosterIsDeleted ? '?' : lastPosterName.charAt(0).toUpperCase();
  const lastPosterIsOP = !lastReply;

  return (
    <Link
      to={`/community/discussions/${discussion.slug || discussion._id}`}
      className="discussion-card card"
      data-pinned={discussion.isPinned ? 'true' : undefined}
    >
      <div className="discussion-card__main">
        <div className="discussion-card__header">
          <CategoryBadge category={discussion.category} />
          {discussion.hasUnread && (
            <span className="discussion-card__unread-dot" title={t('discussions.hasUnread')} aria-label={t('discussions.hasUnread')} />
          )}
          {discussion.isPinned && <span className="discussion-card__pinned" title={t('discussions.pinned')}>📌 {t('discussions.pinned')}</span>}
          {discussion.isLocked && <span className="discussion-card__locked" title={t('discussions.locked')}>{t('discussions.locked')}</span>}
        </div>

        <h3 className="discussion-card__title">{discussion.title}</h3>

        {discussion.wineDefinition && (
          <span className="discussion-card__wine-tag">
            <span className={`discussion-card__wine-dot ${discussion.wineDefinition.type || ''}`} />
            {discussion.wineDefinition.name}
            {discussion.wineDefinition.producer && ` — ${discussion.wineDefinition.producer}`}
          </span>
        )}

        <p className="discussion-card__body">{preview}</p>

        <div className="discussion-card__op">
          <span className="discussion-card__author">
            {authorIsDeleted ? (
              <span className="discussion-card__author-link discussion-card__author-link--deleted">
                {authorName}
              </span>
            ) : (
              <Link
                to={`/users/${author._id}`}
                className="discussion-card__author-link"
                onClick={e => e.stopPropagation()}
              >
                {authorName}
              </Link>
            )}
            {!authorIsDeleted && author.roles?.includes('moderator') && <span className="badge badge--mod">{t('discussions.mod')}</span>}
            {!authorIsDeleted && author.roles?.includes('admin') && <span className="badge badge--admin">{t('discussions.admin')}</span>}
            {!authorIsDeleted && <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} plan={author.plan} />}
          </span>
        </div>
      </div>

      <div className="discussion-card__side">
        {/* Last-poster preview: who replied last, when. The hero of forum
            "is this thread alive?" scanning. Falls back to the OP for empty
            threads so the slot stays consistent. */}
        <div className="discussion-card__last-poster" title={lastPosterName}>
          <span className={`discussion-card__avatar ${lastPosterIsDeleted ? 'discussion-card__avatar--deleted' : ''}`} aria-hidden="true">{lastPosterInitial}</span>
          <span className="discussion-card__last-poster-meta">
            <span className="discussion-card__last-poster-name">
              {lastPosterIsOP ? t('discussions.startedBy', { name: lastPosterName }) : lastPosterName}
            </span>
            <span className="discussion-card__time">
              {timeAgo(lastReply?.createdAt || discussion.lastActivityAt || discussion.createdAt)}
            </span>
          </span>
        </div>
        <span className="discussion-card__replies" aria-label={`${discussion.replyCount || 0} ${discussion.replyCount === 1 ? t('discussions.reply') : t('discussions.replies')}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span className="discussion-card__reply-count">{discussion.replyCount || 0}</span>
        </span>
      </div>
    </Link>
  );
}
