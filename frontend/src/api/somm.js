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
