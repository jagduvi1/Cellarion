import { JSON_HEADERS } from './apiConstants';

export const searchWines = (apiFetch, params) =>
  apiFetch(`/api/wines?${params}`);

export const getWine = (apiFetch, id) =>
  apiFetch(`/api/wines/${id}`);

/**
 * Scan a bottle label with AI. Returns:
 *   { extracted: { name, producer, vintage, country, region, appellation, type, grapes[] },
 *     match: { wine, confidence } | null }
 */
export const scanLabel = (apiFetch, image, mediaType = 'image/jpeg') =>
  apiFetch('/api/wines/scan-label', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ image, mediaType }),
  });

/**
 * Resolve confirmed wine data against the shared registry. READ-ONLY — this
 * NEVER creates (the endpoint keeps its /find-or-create path for
 * compatibility, but it went resolve-only when step-1 minting left 31
 * zero-bottle orphan rows on prod). A wine is only ever minted when the user
 * COMMITS: POST /api/bottles or POST /api/wishlist with a `newWine` payload
 * (this same wineData object, `source: 'ai'` riding along when the data came
 * from an accepted AI suggestion so provenance stays measurable).
 *
 * Returns: { wine, created: false }            — confident registry match
 *        | { candidates: [{ wine, score }] }   — soft zone: ask "did you mean…?"
 *        | { wine: null, created: false, noMatch: true }
 *                                              — not registered; carry the
 *                                                fields to the commit, which mints.
 */
export const resolveWine = (apiFetch, wineData) =>
  apiFetch('/api/wines/find-or-create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(wineData),
  });

/**
 * Identify a wine from a free-text search query using AI and report what the
 * registry already holds. READ-ONLY — this never creates anything. Accepting a
 * suggestion goes through resolveWine above, and the wine is only minted when
 * the bottle/wishlist item is committed (`newWine` on that POST).
 *
 * Returns: {
 *   identified: { name, producer, country, region, appellation, type,
 *                 grapes: string[], confidence } | null,
 *   match:      { wine: WineDefinition } | null,
 *   candidates: [{ wine: WineDefinition, score }],
 *   reason:     string | null
 * }
 *
 * `identified` is UNSAVED: country/region/grapes are plain name strings, not DB
 * IDs, and there is no _id — the same shape getAiWineInfo returns. Only
 * `match.wine` and `candidates[].wine` are persisted documents safe to use as a
 * selected wine. Four states:
 *   identified === null                          → the model found nothing (see reason)
 *   match !== null                               → already in the registry
 *   candidates.length > 0                        → near-matches to choose from
 *   identified && !match && !candidates.length   → identified but NOT in the registry
 */
export const identifyWineByText = (apiFetch, query) =>
  apiFetch('/api/wines/identify-text', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ query }),
  });

/**
 * Ask AI for wine info without creating anything in the DB.
 * Returns: { wine: { name, producer, country, region, appellation, type, grapes[] } | null }
 * country/region/grapes are plain name strings, not DB IDs.
 */
export const getAiWineInfo = (apiFetch, query) =>
  apiFetch('/api/wines/ai-info', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ query }),
  });

/**
 * Public-readable list of community discussions linked to a wine. Used by the
 * WineDetail "Discussions about this wine" panel.
 * Returns: { discussions, total, page, pages }
 */
export const getWineDiscussions = (apiFetch, idOrSlug, params = '') =>
  apiFetch(`/api/wines/${idOrSlug}/discussions${params ? `?${params}` : ''}`);
