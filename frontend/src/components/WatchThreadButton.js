import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { watchDiscussion, unwatchDiscussion } from '../api/discussions';
import './WatchThreadButton.css';

/**
 * Follow / Unfollow toggle for an entire discussion thread (vs FollowButton
 * which follows a user). Renders on the discussion-detail header.
 *
 * - Anon users see "Sign in to follow" linking to /login?next=...
 * - Authors auto-follow on post (server-side); button starts as "Following"
 * - Toggle is optimistic; rolls back on server failure
 */
export default function WatchThreadButton({ idOrSlug, isWatching, watcherCount, onChange }) {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [watching, setWatching] = useState(!!isWatching);
  const [count, setCount] = useState(watcherCount || 0);
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <Link
        to={`/login?next=${encodeURIComponent(window.location.pathname)}`}
        className="watch-thread-btn watch-thread-btn--anon"
      >
        🔔 {t('discussions.signInToFollow')}
      </Link>
    );
  }

  const handleToggle = async () => {
    if (busy) return;
    setBusy(true);
    const wasWatching = watching;
    setWatching(!wasWatching);
    setCount(c => Math.max(0, c + (wasWatching ? -1 : 1)));

    try {
      const res = wasWatching
        ? await unwatchDiscussion(apiFetch, idOrSlug)
        : await watchDiscussion(apiFetch, idOrSlug);
      if (res.ok) {
        const data = await res.json();
        setWatching(!!data.watching);
        onChange?.(!!data.watching);
      } else {
        setWatching(wasWatching);
        setCount(c => Math.max(0, c + (wasWatching ? 1 : -1)));
      }
    } catch {
      setWatching(wasWatching);
      setCount(c => Math.max(0, c + (wasWatching ? 1 : -1)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`watch-thread-btn ${watching ? 'is-watching' : ''}`}
      onClick={handleToggle}
      disabled={busy}
      aria-pressed={watching}
    >
      <span aria-hidden="true">{watching ? '🔔' : '🔕'}</span>
      <span>{watching ? t('discussions.following') : t('discussions.follow')}</span>
      {count > 0 && <span className="watch-thread-btn__count">{count}</span>}
    </button>
  );
}
