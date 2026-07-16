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

export const moveSlot = (apiFetch, rackId, fromPosition, toPosition) =>
  apiFetch(`/api/racks/${rackId}/slots/${fromPosition}/move`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ toPosition }),
  });

// Auto-arrange — server-side engine (same one the MCP auto_arrange tool uses).
// preview computes the plan; apply takes it back ({ target, before }) and the
// server re-validates everything. Undo = apply with target/before swapped.
export const previewArrange = (apiFetch, rackId, { strategy, positionOrder }) =>
  apiFetch(`/api/racks/${rackId}/arrange/preview`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ strategy, positionOrder }),
  });

export const applyArrange = (apiFetch, rackId, { target, before }) =>
  apiFetch(`/api/racks/${rackId}/arrange/apply`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ target, before }),
  });

export const disableSlot = (apiFetch, rackId, position) =>
  apiFetch(`/api/racks/${rackId}/slots/${position}/disable`, { method: 'POST' });

export const enableSlot = (apiFetch, rackId, position) =>
  apiFetch(`/api/racks/${rackId}/slots/${position}/disable`, { method: 'DELETE' });

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
