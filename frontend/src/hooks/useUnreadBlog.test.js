/**
 * Unread-blog counting.
 *
 * The failure mode this guards is quiet, not loud: a badge that counts wrong
 * either nags forever about posts already read, or stays silent when something
 * new is up. Neither throws, and neither is visible in a screenshot — so the
 * counting rule is pinned directly.
 */
import { describe, it, expect } from 'vitest';
import { countUnread, firstRunLastSeen } from './useUnreadBlog';

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
    // The hook always seeds before counting (see firstRunLastSeen), so this is
    // the defensive floor: absent a stamp, count nothing rather than everything.
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

describe('firstRunLastSeen', () => {
  const NEWEST = '2026-08-03T09:00:00.000Z';
  const posts = [post(NEWEST), post('2026-07-20T09:00:00.000Z'), post('2026-06-01T09:00:00.000Z')];

  it('leaves exactly the newest post unread', () => {
    // The whole point: a first-time reader gets one badge inviting them to the
    // latest post — not zero (feature invisible) and not the back catalogue.
    expect(countUnread(posts, firstRunLastSeen(posts))).toBe(1);
  });

  it('lands one millisecond before the newest post', () => {
    expect(firstRunLastSeen(posts)).toBe('2026-08-03T08:59:59.999Z');
  });

  it('finds the newest post regardless of response order', () => {
    // Derived rather than trusting posts[0]: the endpoint sorts descending
    // today, but a future tag filter or pagination change must not silently
    // turn the badge into "every post is unread".
    const shuffled = [posts[2], posts[0], posts[1]];
    expect(firstRunLastSeen(shuffled)).toBe(firstRunLastSeen(posts));
    expect(countUnread(shuffled, firstRunLastSeen(shuffled))).toBe(1);
  });

  it('ignores posts with unusable dates when picking the newest', () => {
    const messy = [{ slug: 'no-date' }, { slug: 'bad', publishedAt: 'soon' }, post(NEWEST)];
    expect(firstRunLastSeen(messy)).toBe('2026-08-03T08:59:59.999Z');
  });

  it('falls back to now when there is nothing to invite anyone to', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    expect(firstRunLastSeen([], now)).toBe('2026-08-03T12:00:00.000Z');
    expect(firstRunLastSeen(undefined, now)).toBe('2026-08-03T12:00:00.000Z');
    expect(firstRunLastSeen([{ slug: 'no-date' }], now)).toBe('2026-08-03T12:00:00.000Z');
  });

  it('shows one badge, not two, when a second post lands before the first visit', () => {
    // Seeded once and stored, so the count grows normally from there — the
    // seeding rule must not re-run and re-hide older unread posts.
    const seeded = firstRunLastSeen(posts);
    const later = [post('2026-08-04T09:00:00.000Z'), ...posts];
    expect(countUnread(later, seeded)).toBe(2);
  });
});
