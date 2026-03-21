import { JSON_HEADERS } from './apiConstants';

export const getRacks = (apiFetch, cellarId) =>
  apiFetch(`/api/racks?cellar=${cellarId}`);

export const deleteRack = (apiFetch, rackId) =>
  apiFetch(`/api/racks/${rackId}`, { method: 'DELETE' });

export const updateSlot = (apiFetch, rackId, position, data) =>
  apiFetch(`/api/racks/${rackId}/slots/${position}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const clearSlot = (apiFetch, rackId, position) =>
  apiFetch(`/api/racks/${rackId}/slots/${position}`, { method: 'DELETE' });

export const createRack = (apiFetch, data) =>
  apiFetch('/api/racks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateRack = (apiFetch, rackId, data) =>
  apiFetch(`/api/racks/${rackId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const resolveNfcRack = (apiFetch, rackId) =>
  apiFetch(`/api/racks/nfc/${rackId}`);
