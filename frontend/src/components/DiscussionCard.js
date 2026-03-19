import { Link } from 'react-router-dom';
import CategoryBadge from './CategoryBadge';
import './DiscussionCard.css';

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

export default function DiscussionCard({ discussion }) {
  const author = discussion.author || {};
  const authorName = author.displayName || author.username || 'Unknown';

  return (
    <Link to={`/community/discussions/${discussion._id}`} className="discussion-card card">
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

      <p className="discussion-card__body">
        {discussion.body.length > 150 ? discussion.body.slice(0, 150) + '...' : discussion.body}
      </p>

      <div className="discussion-card__footer">
        <span className="discussion-card__author">
          <Link
            to={`/users/${author._id}`}
            className="discussion-card__author-link"
            onClick={e => e.stopPropagation()}
          >
            {authorName}
          </Link>
          {author.roles?.includes('moderator') && <span className="badge badge--mod">Mod</span>}
          {author.roles?.includes('admin') && <span className="badge badge--admin">Admin</span>}
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
