import { useCallback, useEffect, useState } from 'react';
import { getClassifications } from '../api/taxonomy';

/**
 * The classification taxonomy ({ _id, name, kind, country }) for the tier
 * picker, loaded the first time a form that needs it opens and held for the
 * tab's lifetime, as useGrapeNames holds the grape list: under a hundred rows
 * that change only when an admin edits the taxonomy.
 *
 * `enabled` keeps the request off the bottle page itself: most visits never
 * open the form, so the list is fetched when somebody does.
 *
 * Never throws: a failed load leaves `classifications` null with `error` set.
 * A failure is NOT cached — the next attempt asks again.
 */

let cached = null;      // [{ _id, name, kind, country, … }]
let inFlight = null;    // promise

function load(apiFetch) {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = getClassifications(apiFetch)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body || !Array.isArray(body.classifications)) throw new Error('bad classification list');
      cached = body.classifications;
      return cached;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export default function useClassifications(apiFetch, enabled = true) {
  const [classifications, setClassifications] = useState(cached);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    if (cached) { setClassifications(cached); return undefined; }
    let active = true;
    setError(false);
    load(apiFetch)
      .then((list) => { if (active) setClassifications(list); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [apiFetch, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { classifications, error, retry };
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetClassificationsCache() {
  cached = null;
  inFlight = null;
}
