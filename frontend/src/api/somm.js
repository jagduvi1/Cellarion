// Sommelier curation endpoints. Project convention: pages import typed
// functions from here rather than writing raw URL strings (see CLAUDE.md).

/** The allowed enum values / list limits the backend validator enforces. */
export const getSommWineProfileSchema = (apiFetch) =>
  apiFetch('/api/somm/wine-profile/schema');

/**
 * Correct a wine's tasting profile. Field-level: omit a key to leave it alone,
 * pass null to clear it.
 */
export const updateSommWineProfile = (apiFetch, wineId, patch) =>
  apiFetch(`/api/somm/wine-profile/${wineId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

/**
 * Take a wine+vintage out of the maturity queue without curating it, for a
 * vintage the wine has not been released in.
 *
 * `deferUntil`: omit for the backend's default (vintage + 2 years, at least a
 * year out); an ISO 'YYYY-MM-DD' for a chosen date; null for indefinite.
 */
export const deferMaturityProfile = (apiFetch, profileId, { deferUntil, reason } = {}) =>
  apiFetch(`/api/somm/maturity/${profileId}/defer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(deferUntil !== undefined ? { deferUntil } : {}),
      ...(reason ? { reason } : {}),
    }),
  });

/** Send a deferred wine+vintage back to the pending queue now. */
export const returnMaturityProfile = (apiFetch, profileId) =>
  apiFetch(`/api/somm/maturity/${profileId}/defer`, { method: 'DELETE' });
