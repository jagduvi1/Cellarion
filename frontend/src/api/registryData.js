import { JSON_HEADERS } from './apiConstants';

// Public key vocabulary + values (#985 Slice B).
// Mirrors backend routes/registryData.js + routes/admin/registryData.js.

// `lang` is what the UI is showing; the server answers with each key's
// displayName in that language when a translation exists, else its name.
export const getRegistryKeys = (apiFetch, lang) =>
  apiFetch(`/api/registry-data/keys${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`);

export const proposeRegistryKey = (apiFetch, data) =>
  apiFetch('/api/registry-data/keys', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

// `vintage` (YYYY) resolves that bottling's override over the wine-wide
// default and tells the server which slot a new suggestion lands in.
// `lang` picks each key's displayName (see getRegistryKeys).
export const getWinePublicData = (apiFetch, wineId, vintage, lang) => {
  const params = new URLSearchParams();
  if (vintage) params.set('vintage', vintage);
  if (lang) params.set('lang', lang);
  const qs = params.toString();
  return apiFetch(`/api/registry-data/wine/${wineId}${qs ? `?${qs}` : ''}`);
};

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

// Replace a key's display-name translations ({ de: 'Alkoholgehalt', … }).
// A full replacement: a language left out is removed.
export const setRegistryKeyTranslations = (apiFetch, keyId, translations) =>
  apiFetch(`/api/admin/registry-data/keys/${keyId}/translations`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ translations }),
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
