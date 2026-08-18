import { JSON_HEADERS } from './apiConstants';

// Public key vocabulary + values (#985 Slice B).
// Mirrors backend routes/registryData.js + routes/admin/registryData.js.

export const getRegistryKeys = (apiFetch) =>
  apiFetch('/api/registry-data/keys');

export const proposeRegistryKey = (apiFetch, data) =>
  apiFetch('/api/registry-data/keys', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const getWinePublicData = (apiFetch, wineId) =>
  apiFetch(`/api/registry-data/wine/${wineId}`);

export const suggestWineValue = (apiFetch, wineId, data) =>
  apiFetch(`/api/registry-data/wine/${wineId}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

// Admin review surface
export const getRegistryDataQueues = (apiFetch) =>
  apiFetch('/api/admin/registry-data');

export const decideRegistryKey = (apiFetch, keyId, decision, rejectReason) =>
  apiFetch(`/api/admin/registry-data/keys/${keyId}/decide`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ decision, ...(rejectReason ? { rejectReason } : {}) }),
  });

export const decideRegistryValue = (apiFetch, valueId, decision, rejectReason) =>
  apiFetch(`/api/admin/registry-data/values/${valueId}/decide`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ decision, ...(rejectReason ? { rejectReason } : {}) }),
  });
