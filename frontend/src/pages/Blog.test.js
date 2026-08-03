/**
 * Which tags the blog filter renders.
 *
 * The security-relevant rule (audit 2026-08-03, L-1): `activeTag` arrives from
 * the query string, so rendering it unchecked let `?tag=<anything>` place an
 * attacker-chosen pill among the real ones. React escapes it, so this was never
 * XSS — but it was a convincing spot for "⚠ Verify your account here", and it
 * failed silently in the sense that the page looked entirely normal.
 */
import { describe, it, expect } from 'vitest';
import { visibleTagsFor } from './Blog';

const TAGS = ['feature', 'release', 'guide', 'wine-storage', 'community', 'ai', 'mcp', 'gdpr', 'undo', 'wishlist'];

describe('visibleTagsFor', () => {
  it('collapses to the first N tags', () => {
    expect(visibleTagsFor(TAGS, '', false, 8)).toEqual(TAGS.slice(0, 8));
  });

  it('returns every tag when expanded', () => {
    expect(visibleTagsFor(TAGS, '', true, 8)).toEqual(TAGS);
  });

  it('keeps a real active tag visible when it falls outside the collapsed set', () => {
    // 'wishlist' is 10th — without this the filter would be on with no control
    // to switch it off.
    const out = visibleTagsFor(TAGS, 'wishlist', false, 8);
    expect(out).toContain('wishlist');
    expect(out).toHaveLength(9);
  });

  it('does not duplicate an active tag already inside the collapsed set', () => {
    const out = visibleTagsFor(TAGS, 'feature', false, 8);
    expect(out.filter((t) => t === 'feature')).toHaveLength(1);
    expect(out).toHaveLength(8);
  });

  it('drops an active tag that is not a real tag', () => {
    // The finding: this string came from ?tag= and was rendered as a pill.
    const out = visibleTagsFor(TAGS, '⚠ Verify your account here', false, 8);
    expect(out).toEqual(TAGS.slice(0, 8));
  });

  it('drops an unknown tag even when the list is expanded', () => {
    expect(visibleTagsFor(TAGS, 'not-a-tag', true, 8)).toEqual(TAGS);
  });

  it('ignores a huge unknown value rather than rendering it', () => {
    // An 8 kB ?tag= value broke the filter-row layout.
    expect(visibleTagsFor(TAGS, 'x'.repeat(8000), false, 8)).toEqual(TAGS.slice(0, 8));
  });

  it('survives a missing or non-array tag list', () => {
    expect(visibleTagsFor(undefined, 'feature', false, 8)).toEqual([]);
    expect(visibleTagsFor(null, '', true, 8)).toEqual([]);
  });
});
