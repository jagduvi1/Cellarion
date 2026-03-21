import { JSON_HEADERS } from './apiConstants';

export const getCellarLayout = (apiFetch, cellarId) =>
  apiFetch(`/api/cellar-layout?cellar=${cellarId}`);

export const saveCellarLayout = (apiFetch, data) =>
  apiFetch('/api/cellar-layout', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
