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
 * Remove a wine+vintage from the maturity queue without curating it — for a
 * vintage the wine was never released in. The pair re-enters the queue
 * automatically the next time anyone adds a bottle of that wine+vintage.
 */
export const removeMaturityProfile = (apiFetch, profileId) =>
  apiFetch(`/api/somm/maturity/${profileId}`, { method: 'DELETE' });
