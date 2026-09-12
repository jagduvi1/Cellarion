import { JSON_HEADERS } from './apiConstants';

// Private draft wines (/api/wine-drafts): a wine created privately, edited
// directly, and published to the shared registry as an explicit step.

export const listMyWineDrafts = (apiFetch) => apiFetch('/api/wine-drafts');

export const getWineDraft = (apiFetch, id) => apiFetch(`/api/wine-drafts/${id}`);

export const updateWineDraft = (apiFetch, id, patch) =>
  apiFetch(`/api/wine-drafts/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });

/** 200 published | 409 { code:'duplicate', match } | 409 { code:'similar', candidates } | 400 invalid_identity */
export const publishWineDraft = (apiFetch, id, { confirmCreate = false } = {}) =>
  apiFetch(`/api/wine-drafts/${id}/publish`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ confirmCreate }) });

export const publishWineDrafts = (apiFetch, ids, { confirmCreate = false } = {}) =>
  apiFetch('/api/wine-drafts/publish', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids, confirmCreate }) });

/** Move the draft's bottles onto an existing registry wine; the draft is dissolved. */
export const attachWineDraft = (apiFetch, id, targetWineId) =>
  apiFetch(`/api/wine-drafts/${id}/attach`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ targetWineId }) });

export const deleteWineDraft = (apiFetch, id) =>
  apiFetch(`/api/wine-drafts/${id}`, { method: 'DELETE' });
