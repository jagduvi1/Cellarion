import { JSON_HEADERS } from './apiConstants';

// Personal typed key/value data on wines and bottles (issue #986).
// Mirrors backend routes/personalData.js.

export const getPersonalData = (apiFetch, bottleId) =>
  apiFetch(`/api/personal-data/bottle/${bottleId}`);

export const addPersonalData = (apiFetch, bottleId, data) =>
  apiFetch(`/api/personal-data/bottle/${bottleId}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updatePersonalDataEntry = (apiFetch, entryId, value) =>
  apiFetch(`/api/personal-data/entries/${entryId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  });

export const deletePersonalDataEntry = (apiFetch, entryId) =>
  apiFetch(`/api/personal-data/entries/${entryId}`, { method: 'DELETE' });

export const getPersonalDataKeys = (apiFetch) =>
  apiFetch('/api/personal-data/keys');

// Rename a key, change its unit, or replace the allowed values of a list key.
export const updatePersonalDataKey = (apiFetch, keyId, data) =>
  apiFetch(`/api/personal-data/keys/${keyId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
