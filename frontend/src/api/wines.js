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
 * Find an existing wine or create a new one from confirmed label data.
 * Returns: { wine: WineDefinition, created: boolean }
 */
export const findOrCreateWine = (apiFetch, wineData) =>
  apiFetch('/api/wines/find-or-create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(wineData),
  });

/**
 * Identify a wine from a free-text search query using AI, then find or create
 * it in the registry.
 * Returns: { wine: WineDefinition | null, created?: boolean, reason?: string }
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
