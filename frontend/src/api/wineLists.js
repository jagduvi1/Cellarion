import { JSON_HEADERS } from './apiConstants';

export const getWineLists = (apiFetch, cellarId) =>
  apiFetch(`/api/wine-lists?cellar=${cellarId}`);

export const createWineList = (apiFetch, data) =>
  apiFetch('/api/wine-lists', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const getWineList = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}`);

export const updateWineList = (apiFetch, id, data) =>
  apiFetch(`/api/wine-lists/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const deleteWineList = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}`, { method: 'DELETE' });

export const publishWineList = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}/publish`, { method: 'POST' });

export const unpublishWineList = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}/unpublish`, { method: 'POST' });

export const uploadWineListLogo = (apiFetch, id, formData) =>
  apiFetch(`/api/wine-lists/${id}/logo`, {
    method: 'POST',
    body: formData,
  });

export const getWineListStats = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}/stats`);

export const previewWineListPdf = (apiFetch, id) =>
  apiFetch(`/api/wine-lists/${id}/preview-pdf`);
