/**
 * Unread-blog counting.
 *
 * The failure mode this guards is quiet, not loud: a badge that counts wrong
 * either nags forever about posts already read, or stays silent when something
 * new is up. Neither throws, and neither is visible in a screenshot — so the
 * counting rule is pinned directly.
 */
import { describe, it, expect } from 'vitest';
import { countUnread } from './useUnreadBlog';

const post = (publishedAt) => ({ slug: `p-${publishedAt}`, publishedAt });

const SEEN = '2026-08-01T12:00:00.000Z';

describe('countUnread', () => {
  it('counts only posts published strictly after the last visit', () => {
    const posts = [
      post('2026-08-03T09:00:00.000Z'), // after
      post('2026-08-02T09:00:00.000Z'), // after
      post('2026-07-30T09:00:00.000Z'), // before
    ];
    expect(countUnread(posts, SEEN)).toBe(2);
  });

  it('treats a post published at exactly the last-seen moment as read', () => {
    // markBlogSeen() stamps "now" as the reader opens the list, so a post whose
    // timestamp ties with it was on the page they just looked at. Counting it
    // would leave a badge that reappears the instant it is cleared.
    expect(countUnread([post(SEEN)], SEEN)).toBe(0);
  });

  it('returns 0 when nothing is newer', () => {
    expect(countUnread([post('2026-07-01T00:00:00.000Z')], SEEN)).toBe(0);
  });

  it('returns 0 without a last-seen timestamp rather than counting everything', () => {
    // First run seeds the timestamp instead of counting the back catalogue —
    // a badge reading "12" on someone's first login is noise, not news.
    expect(countUnread([post('2026-08-03T09:00:00.000Z')], null)).toBe(0);
    expect(countUnread([post('2026-08-03T09:00:00.000Z')], undefined)).toBe(0);
    expect(countUnread([post('2026-08-03T09:00:00.000Z')], '')).toBe(0);
  });

  it('ignores an unparseable last-seen value instead of counting everything', () => {
    // Storage is user-writable and survives across versions; a corrupt value
    // must not turn into "every post is unread".
    expect(countUnread([post('2026-08-03T09:00:00.000Z')], 'not-a-date')).toBe(0);
  });

  it('skips posts with a missing or unparseable publish date', () => {
    const posts = [
      post('2026-08-03T09:00:00.000Z'),
      { slug: 'draft-ish' }, // no publishedAt
      { slug: 'broken', publishedAt: 'sometime' },
      null,
    ];
    expect(countUnread(posts, SEEN)).toBe(1);
  });

  it('returns 0 for a non-array payload', () => {
    // apiFetch resolves on non-2xx, so an error body ({error: '…'}) can reach
    // this with no posts array at all.
    expect(countUnread(undefined, SEEN)).toBe(0);
    expect(countUnread({ error: 'nope' }, SEEN)).toBe(0);
    expect(countUnread([], SEEN)).toBe(0);
  });
});
