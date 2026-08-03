import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getBlogPosts } from '../api/blog';

export const STORAGE_KEY = 'blogLastSeenAt';

// One page of posts is enough to count against. The badge exists to say "there
// is something new", not to be an inbox — and since the first run seeds the
// timestamp (see below), a reader can only accumulate unread posts at the rate
// we publish them. A count that hits the cap is reported as the cap.
export const SCAN_LIMIT = 20;

/**
 * How many of `posts` were published after `lastSeenAt`.
 *
 * Pure and exported because the counting rule is the whole feature: an
 * unparseable date must not silently become "unread", and a missing timestamp
 * must mean zero rather than everything. Far easier to pin here than through a
 * rendered nav bar.
 */
export function countUnread(posts, lastSeenAt) {
  if (!Array.isArray(posts) || !lastSeenAt) return 0;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return 0;
  return posts.filter((post) => {
    const at = Date.parse(post?.publishedAt);
    return !Number.isNaN(at) && at > seen;
  }).length;
}

// Storage can throw outright — Safari private mode, or a browser configured to
// block it. The badge is decorative, so every access degrades to "no badge"
// rather than taking the navigation bar down with it.
const readLastSeen = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeLastSeen = (iso) => {
  try {
    localStorage.setItem(STORAGE_KEY, iso);
  } catch {
    /* storage unavailable — the badge simply won't persist */
  }
};

// The blog page and the nav are in different subtrees, so clearing the badge on
// visit needs a channel between them. A module-level subscriber set is enough:
// this is one boolean's worth of state, and a context provider around the whole
// app would be more wiring than the feature is worth.
const subscribers = new Set();

/** Called when the reader opens /blog — everything published so far is now seen. */
export function markBlogSeen() {
  const now = new Date().toISOString();
  writeLastSeen(now);
  subscribers.forEach((notify) => notify());
}

/** Unread post count for the nav badge. Always 0 when signed out. */
export default function useUnreadBlog() {
  const { apiFetch, user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user) {
      setCount(0);
      return undefined;
    }

    const stored = readLastSeen();
    if (!stored) {
      // First run: treat the back catalogue as already read. A badge counting
      // every post ever published is noise on someone's first login, not news —
      // the promise is "new since you last looked", and there is no last look yet.
      writeLastSeen(new Date().toISOString());
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await getBlogPosts(apiFetch, { limit: SCAN_LIMIT });
        // apiFetch resolves on non-2xx too, and an error body has no posts array.
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setCount(countUnread(data?.posts, stored));
      } catch {
        /* offline or malformed — leave the badge off */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiFetch, user]);

  useEffect(() => {
    const clear = () => setCount(0);
    subscribers.add(clear);
    return () => {
      subscribers.delete(clear);
    };
  }, []);

  return count;
}
