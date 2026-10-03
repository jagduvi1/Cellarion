/**
 * Umami event helper: a no-op without the tracker, and never able to break the
 * action it counts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { track } from './track';

afterEach(() => { delete window.umami; });

describe('track', () => {
  it('does nothing when the tracker is not loaded', () => {
    expect(() => track('signup-completed')).not.toThrow();
  });

  it('forwards the event name and data to Umami', () => {
    window.umami = { track: vi.fn() };
    track('bottle-added', { count: 2 });
    track('shared-list-cta');
    expect(window.umami.track).toHaveBeenNthCalledWith(1, 'bottle-added', { count: 2 });
    expect(window.umami.track).toHaveBeenNthCalledWith(2, 'shared-list-cta');
  });

  it('swallows a tracker that throws', () => {
    window.umami = { track: () => { throw new Error('blocked'); } };
    expect(() => track('import-finished')).not.toThrow();
  });
});
