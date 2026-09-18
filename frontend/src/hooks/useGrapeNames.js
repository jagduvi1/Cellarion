import { useCallback, useEffect, useState } from 'react';
import { getGrapeNames } from '../api/taxonomy';

/**
 * The grape vocabulary for the grape picker, loaded the first time a form that
 * needs it opens and held for the tab's lifetime (same reasoning as
 * useTaxonomyNames: it changes about as often as the taxonomy does, and the
 * endpoint is `Cache-Control: private, max-age=3600` besides).
 *
 * `enabled` keeps the request off the bottle page itself: most visits never
 * open the form, so the list is fetched when somebody does.
 *
 * Never throws: a failed load leaves `grapes` null with `error` set, and the
 * picker offers a retry. A failure is NOT cached — the next attempt asks again.
 */

let cached = null;      // [{ name, color, synonyms, wineCount }]
let inFlight = null;    // promise

function load(apiFetch) {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = getGrapeNames(apiFetch)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body || !Array.isArray(body.grapes)) throw new Error('bad grape list');
      cached = body.grapes;
      return cached;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export default function useGrapeNames(apiFetch, enabled = true) {
  const [grapes, setGrapes] = useState(cached);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    if (cached) { setGrapes(cached); return undefined; }
    let active = true;
    setError(false);
    load(apiFetch)
      .then((list) => { if (active) setGrapes(list); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [apiFetch, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { grapes, error, retry };
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetGrapeNamesCache() {
  cached = null;
  inFlight = null;
}
