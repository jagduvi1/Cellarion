import { lazy as reactLazy } from 'react';

/**
 * React.lazy that survives a deploy.
 *
 * THE FAILURE. Vite hashes every chunk filename, so a deploy replaces
 * `AdminSupportTickets-DK3bBmQy.js` with a differently-hashed file and deletes
 * the old one. A browser tab open across that deploy still holds the OLD module
 * graph: navigating to a route it hasn't visited yet requests a filename that
 * no longer exists, the import rejects on a 404, and — because a rejected lazy
 * import is thrown, not caught — it propagates past Suspense to the root
 * ErrorBoundary and takes the WHOLE app down, not just that route.
 *
 * Reported twice on 2026-08-21: once as "the dashboard is blank" by a user,
 * where it went undiagnosed for hours because the symptom is silent, and once
 * with the console 404 that finally named it. Seven deploys shipped that day,
 * so every open tab had seven chances to hit it.
 *
 * THE FIX is to reload once. index.html is served no-store, so a reload fetches
 * the new module graph and the route renders. There is nothing to lose by
 * reloading at that point: the route has already failed to render.
 *
 * ⚠️ THE GUARD IS THE LOAD-BEARING PART. Without it a chunk that is missing for
 * any OTHER reason — a bad build, an offline client, a proxy eating the request
 * — reloads, fails, reloads, forever. One retry per session, and the second
 * failure is rethrown so the ErrorBoundary can show something honest instead of
 * a page that flickers.
 *
 * The key clears on the next successful chunk load, so a later deploy gets its
 * own single retry rather than inheriting a spent one.
 */
const RETRY_KEY = 'cellarion:chunk-reload';

// sessionStorage throws in Safari private mode and when storage is disabled.
// A recovery path must not itself be the thing that breaks.
function readFlag() {
  try { return window.sessionStorage.getItem(RETRY_KEY); } catch { return null; }
}
function writeFlag(value) {
  try {
    if (value === null) window.sessionStorage.removeItem(RETRY_KEY);
    else window.sessionStorage.setItem(RETRY_KEY, value);
  } catch { /* storage unavailable — one attempt, no retry, still no loop */ }
}

/**
 * The retry rule, as a plain factory wrapper. Exported separately from `lazy`
 * so it can be tested as the promise logic it is, rather than through a
 * rendered Suspense tree where a reload is hard to observe.
 */
export function withReload(factory) {
  return () => factory().then(
    (mod) => {
      // A chunk loaded, so whatever went wrong before is behind us — let the
      // NEXT deploy have a fresh retry instead of inheriting a spent one.
      if (readFlag()) writeFlag(null);
      return mod;
    },
    (err) => {
      if (readFlag()) throw err; // already retried this session — real error
      writeFlag('1');
      window.location.reload();
      // Never resolves: the reload replaces the document, and resolving here
      // would render a route from a module graph we have just declared stale.
      return new Promise(() => {});
    },
  );
}

export function lazy(factory) {
  return reactLazy(withReload(factory));
}

export { RETRY_KEY };
export default lazy;
