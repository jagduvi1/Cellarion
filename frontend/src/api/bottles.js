import { JSON_HEADERS } from './apiConstants';

/**
 * Cross-cellar bottle list for the authenticated user.
 * `params` is a plain object whose entries become URL query params
 * (arrays are joined with commas, falsy values are skipped).
 */
export const listBottles = (apiFetch, params = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    qs.set(k, Array.isArray(v) ? v.filter(Boolean).join(',') : String(v));
  }
  const query = qs.toString();
  return apiFetch(`/api/bottles${query ? `?${query}` : ''}`);
};

export const getBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}`);

// Create ONE bottle (POST /api/bottles). There is no batch endpoint — a
// multi-bottle add is N sequential calls of this (see AddMoreBottlesModal).
export const createBottle = (apiFetch, data) =>
  apiFetch('/api/bottles', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateBottle = (apiFetch, id, data) =>
  apiFetch(`/api/bottles/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const consumeBottle = (apiFetch, id, data) =>
  apiFetch(`/api/bottles/${id}/consume`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const openBottle = (apiFetch, id, preservationMethod) =>
  apiFetch(`/api/bottles/${id}/open`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ preservationMethod }),
  });

export const undoOpenBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}/open`, { method: 'DELETE' });

export const pourBottle = (apiFetch, id, ml) =>
  apiFetch(`/api/bottles/${id}/pour`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(ml ? { ml } : {}),
  });

export const undoPour = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}/pour`, { method: 'DELETE' });

export const undoBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}/undo`, {
    method: 'POST',
  });

// Put a consumed bottle back to active (inverse of consumeBottle) — for a
// drink/gift/sale logged by mistake. Comes back unplaced.
export const restoreBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}/restore`, {
    method: 'POST',
  });

export const moveBottle = (apiFetch, id, toCellarId) =>
  apiFetch(`/api/bottles/${id}/move`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ toCellarId }),
  });

// Move MANY bottles to another cellar you own in ONE request (POST
// /api/bottles/bulk-move). Partial success comes back in `skipped`.
export const bulkMoveBottles = (apiFetch, bottleIds, toCellarId) =>
  apiFetch('/api/bottles/bulk-move', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ bottleIds, toCellarId }),
  });

// ONE edit applied to MANY bottles (POST /api/bottles/bulk, action 'update').
// `fields` is limited server-side to purchase details + reservation.
export const bulkUpdateBottles = (apiFetch, bottleIds, fields) =>
  apiFetch('/api/bottles/bulk', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ action: 'update', bottleIds, fields }),
  });

// Mark MANY bottles consumed with one reason and one date (action 'consume').
// Reserved ("spoken for") bottles come back in `skipped` as 'reserved' unless
// includeReserved is set.
export const bulkConsumeBottles = (apiFetch, bottleIds, { reason, note, consumedAt, includeReserved } = {}) =>
  apiFetch('/api/bottles/bulk', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ action: 'consume', bottleIds, reason, note, consumedAt, ...(includeReserved ? { includeReserved: true } : {}) }),
  });

export const updateConsumedRating = (apiFetch, id, data) =>
  apiFetch(`/api/bottles/${id}/consumed-rating`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const setBottleDefaultImage = (apiFetch, id, imageId) =>
  apiFetch(`/api/bottles/${id}/default-image`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ imageId }),
  });

export const validateImport = (apiFetch, data) =>
  apiFetch('/api/bottles/import/validate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const confirmImport = (apiFetch, data) =>
  apiFetch('/api/bottles/import/confirm', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
