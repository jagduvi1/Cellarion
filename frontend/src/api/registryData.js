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

// `vintage` (YYYY) resolves that bottling's override over the wine-wide
// default and tells the server which slot a new suggestion lands in.
export const getWinePublicData = (apiFetch, wineId, vintage) =>
  apiFetch(`/api/registry-data/wine/${wineId}${vintage ? `?vintage=${encodeURIComponent(vintage)}` : ''}`);

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

// asWineDefault: publish a vintage-specific suggestion as the wine-wide
// default instead (reviewer judged the evidence to be a producer spec).
export const decideRegistryValue = (apiFetch, valueId, decision, rejectReason, { asWineDefault = false } = {}) =>
  apiFetch(`/api/admin/registry-data/values/${valueId}/decide`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      decision,
      ...(rejectReason ? { rejectReason } : {}),
      ...(asWineDefault ? { asWineDefault: true } : {}),
    }),
  });
