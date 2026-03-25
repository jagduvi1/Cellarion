import { JSON_HEADERS } from './apiConstants';

export const getJournalEntries = (apiFetch, params = '') =>
  apiFetch(`/api/journal${params ? `?${params}` : ''}`);

export const getJournalEntry = (apiFetch, id) =>
  apiFetch(`/api/journal/${id}`);

export const createJournalEntry = (apiFetch, data) =>
  apiFetch('/api/journal', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateJournalEntry = (apiFetch, id, data) =>
  apiFetch(`/api/journal/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const deleteJournalEntry = (apiFetch, id) =>
  apiFetch(`/api/journal/${id}`, { method: 'DELETE' });
