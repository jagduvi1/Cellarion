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

export const undoBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}/undo`, {
    method: 'POST',
  });

export const moveBottle = (apiFetch, id, toCellarId) =>
  apiFetch(`/api/bottles/${id}/move`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ toCellarId }),
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
