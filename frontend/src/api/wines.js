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
 * Find an existing wine or create a new one from CONFIRMED data. The only
 * user-facing registry-write path — call it when the user has explicitly
 * accepted a wine, never speculatively.
 *
 * Pass `source: 'ai'` when the data came from an AI suggestion the user
 * accepted, so the row's provenance stays measurable.
 *
 * Returns: { wine, created: true } | { wine, created: false }
 *        | { candidates: [{ wine, score }] }  — soft zone: ask "did you mean…?"
 *          and resubmit with confirmCreate: true to create anyway.
 */
export const findOrCreateWine = (apiFetch, wineData) =>
  apiFetch('/api/wines/find-or-create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(wineData),
  });

/**
 * Identify a wine from a free-text search query using AI and report what the
 * registry already holds. READ-ONLY — this never creates anything. Accepting a
 * suggestion is a separate, explicit call to findOrCreateWine below.
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
