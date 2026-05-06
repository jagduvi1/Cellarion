import { Link } from 'react-router-dom';
import CategoryBadge from './CategoryBadge';
import CellarCredBadge from './CellarCredBadge';
import { extractForumPlainText } from '../utils/sanitizeForumRender';
import timeAgo from '../utils/timeAgo';
import './DiscussionCard.css';

export default function DiscussionCard({ discussion }) {
  const author = discussion.author || {};
  const authorName = author.displayName || author.username || 'Unknown';
  // Body is sanitized HTML — strip to plain text for the list-card preview.
  // Rendering markup in a 150-char snippet would break paragraphs awkwardly
  // and leak `<p>` tags when the strip regex misses (this view originally
  // rendered `String.slice` over raw HTML, which surfaced the tags as text).
  const bodyPlain = extractForumPlainText(discussion.body);
  const preview = bodyPlain.length > 150 ? bodyPlain.slice(0, 150) + '…' : bodyPlain;

  return (
    <Link to={`/community/discussions/${discussion.slug || discussion._id}`} className="discussion-card card">
      <div className="discussion-card__header">
        <div className="discussion-card__meta">
          <CategoryBadge category={discussion.category} />
          {discussion.isPinned && <span className="discussion-card__pinned" title="Pinned">Pinned</span>}
          {discussion.isLocked && <span className="discussion-card__locked" title="Locked">Locked</span>}
        </div>
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

      <div className="discussion-card__footer">
        <span className="discussion-card__author">
          {/* Deleted users are shown as a non-clickable label — their profile
              page would be a dead-end (sentinel account, no real data). */}
          {deleted ? (
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
          {!deleted && author.roles?.includes('moderator') && <span className="badge badge--mod">Mod</span>}
          {!deleted && author.roles?.includes('admin') && <span className="badge badge--admin">Admin</span>}
          {!deleted && <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} />}
        </span>
        <span className="discussion-card__stats">
          <span className="discussion-card__replies">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {discussion.replyCount}
          </span>
          <span className="discussion-card__time">{timeAgo(discussion.lastActivityAt)}</span>
        </span>
      </div>
    </Link>
  );
}
