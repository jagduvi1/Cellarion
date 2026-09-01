import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../api/apiConstants';
import { EMPTY_DISPLAY_NAMES } from '../utils/taxonomyName';

/**
 * The country and region display names for the current language.
 *
 * One small public map (only the entries that HAVE a name in this language),
 * fetched once per language and held for the tab's lifetime — taxonomy names
 * change about as often as the taxonomy does, and the endpoint is
 * `Cache-Control: public, max-age=3600` besides.
 *
 * Deliberately never throws and never blocks: a failed fetch leaves the map
 * empty, and an empty map means every name renders canonically — which is what
 * the app did before this existed. Localisation is worth having, not worth a
 * blank page.
 */

// Module scope, not component state: every component that mounts wants the
// same map, and this is what stops twenty bottle cards issuing twenty requests.
const cache = new Map();       // lang -> map
const inFlight = new Map();    // lang -> promise

function loadDisplayNames(lang) {
  if (cache.has(lang)) return Promise.resolve(cache.get(lang));
  if (inFlight.has(lang)) return inFlight.get(lang);

  const request = fetch(`${API_URL}/api/taxonomy/display-names?lang=${encodeURIComponent(lang)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body || !body.byId || !body.byName) return EMPTY_DISPLAY_NAMES;
      const map = { byId: body.byId, byName: body.byName };
      // ONLY a valid answer is cached. Caching the empty fallback on a non-OK
      // response looked harmless and wasn't: a 503 during a deploy would have
      // condemned the tab to English for its whole lifetime — the exact thing
      // the catch below already refuses to do for a network failure (found by
      // the pre-merge audit; the two failure paths now agree).
      cache.set(lang, map);
      return map;
    })
    .catch(() => {
      // Not cached either: the next mount simply tries again.
      return EMPTY_DISPLAY_NAMES;
    })
    .finally(() => inFlight.delete(lang));

  inFlight.set(lang, request);
  return request;
}

export default function useTaxonomyNames() {
  // `i18n` is destructured defensively on purpose. Component suites across this
  // codebase mock react-i18next down to just `t`, and a hook that threw on the
  // missing half would make adopting it cost a test edit in every component —
  // which is how a nice-to-have quietly stops being adopted. No i18n means no
  // language means English, which is this module's answer to every other
  // unknown too.
  const { i18n } = useTranslation() || {};
  const lang = (i18n?.language || 'en').split('-')[0].toLowerCase();
  // English needs no map at all — skip the request entirely rather than ask
  // the server for an answer we already know is empty.
  const [names, setNames] = useState(() => (lang === 'en' ? EMPTY_DISPLAY_NAMES : (cache.get(lang) || EMPTY_DISPLAY_NAMES)));

  useEffect(() => {
    if (lang === 'en') { setNames(EMPTY_DISPLAY_NAMES); return undefined; }
    let active = true;
    loadDisplayNames(lang).then((map) => { if (active) setNames(map); });
    return () => { active = false; };
  }, [lang]);

  return names;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetTaxonomyNameCache() {
  cache.clear();
  inFlight.clear();
}
