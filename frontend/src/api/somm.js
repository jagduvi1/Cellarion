// Sommelier curation endpoints. Project convention: pages import typed
// functions from here rather than writing raw URL strings (see CLAUDE.md).

/** The allowed enum values / list limits the backend validator enforces. */
export const getSommWineProfileSchema = (apiFetch) =>
  apiFetch('/api/somm/wine-profile/schema');

/**
 * The pending-identity queue: registry wines minted at bottle-commit from an
 * incomplete identity (unreadable label, missing producer, geography in the
 * producer box). Anonymised — no creator is ever returned.
 * `params` is a URLSearchParams: page, limit, createdVia.
 */
export const sommGetPendingWines = (apiFetch, params) =>
  apiFetch(`/api/somm/pending-wines?${params}`);

/**
 * Complete a pending wine's identity. Fields: producer, name, appellation,
 * regionName, countryName, grapeNames[], type — all optional, send what you
 * fixed. Filling producer + name promotes the wine automatically.
 */
export const sommFixPendingWine = (apiFetch, wineId, patch) =>
  apiFetch(`/api/somm/pending-wines/${wineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

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

/**
 * Decline a price-tracking request with a required reason (5–500 chars,
 * plain text). Every requester is notified with the reason, and the
 * wine+vintage pair is suppressed from future tracking requests
 * (PriceTrackingSkip) until an admin lifts it.
 */
export const declinePriceTrackingRequest = (apiFetch, requestId, reason) =>
  apiFetch(`/api/somm/prices/requests/${requestId}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
