import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authorDisplayName } from '../utils/deletedUser';
import timeAgo from '../utils/timeAgo';
import './DiscussionsFeedWidget.css';

// Compact "latest from the community" widget for the landing page and similar
// surfaces. Public-readable: fetches via plain fetch (no auth header) so anon
// visitors see real content and SSR-style crawler renders work.
//
// Quiet load: renders nothing while fetching, hides itself if the feed is
// empty or the API errors. The landing page mustn't show a broken widget
// to first-time visitors.
export default function DiscussionsFeedWidget({ limit = 5, sort = 'active' }) {
  const { t } = useTranslation();
  const [discussions, setDiscussions] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ limit: String(limit), sort });
        const res = await fetch(`/api/discussions?${params}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setDiscussions(data.discussions || []);
        } else if (!cancelled) {
          setDiscussions([]);
        }
      } catch {
        if (!cancelled) setDiscussions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [limit, sort]);

  // Hide the widget entirely while loading or when there's nothing to show —
  // a landing page deserves a polished empty state, not a stub.
  if (discussions === null || discussions.length === 0) return null;

  return (
    <section className="discussions-feed-widget">
      <div className="discussions-feed-widget__header">
        <h2>{t('discussionsWidget.title')}</h2>
        <Link to="/community/discussions" className="discussions-feed-widget__see-all">
          {t('discussionsWidget.seeAll')}
        </Link>
      </div>
      <ul className="discussions-feed-widget__list">
        {discussions.map(d => {
          const author = d.author || {};
          const authorName = authorDisplayName(author, t, t('discussions.anonymous'));
          const slugOrId = d.slug || d._id;
          return (
            <li key={d._id} className="discussions-feed-widget__item">
              <Link to={`/community/discussions/${slugOrId}`} className="discussions-feed-widget__link">
                <span className="discussions-feed-widget__title">{d.title}</span>
                <span className="discussions-feed-widget__meta">
                  {authorName} · {d.replyCount || 0} {d.replyCount === 1 ? t('discussions.reply') : t('discussions.replies')} · {timeAgo(d.lastActivityAt)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
