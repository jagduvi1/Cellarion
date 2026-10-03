/**
 * Count an action in Umami — "signed up", "added a bottle", "finished an
 * import" — so the funnel from first visit to active user can be seen, not
 * just the pages people opened.
 *
 * Cookieless like the page views: an event is a name plus a few numbers or
 * labels on the same anonymous request. Never pass anything that identifies a
 * person (no ids, names, emails or wine names) — counts and categories only.
 *
 * A no-op wherever the tracker is not loaded: self-hosted installs, routes
 * Analytics.js excludes, tests, and visitors who block it. Never throws, so a
 * call can sit on any success path without guarding it.
 */
export function track(event, data) {
  try {
    if (typeof window === 'undefined' || typeof window.umami?.track !== 'function') return;
    if (data) window.umami.track(event, data);
    else window.umami.track(event);
  } catch {
    // Analytics must never break the action it is counting.
  }
}
