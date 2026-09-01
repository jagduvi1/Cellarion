import { JSON_HEADERS } from './apiConstants';

export const listCellars = (apiFetch) => apiFetch('/api/cellars');

export const getCellar = (apiFetch, id, params = '') =>
  apiFetch(`/api/cellars/${id}${params ? `?${params}` : ''}`);

export const getCellarStatistics = (apiFetch, id, currency) =>
  apiFetch(`/api/cellars/${id}/statistics?currency=${currency}`);

export const getCellarAudit = (apiFetch, id) =>
  apiFetch(`/api/cellars/${id}/audit`);

export const getCellarHistory = (apiFetch, id, params = '') =>
  apiFetch(`/api/cellars/${id}/history${params ? `?${params}` : ''}`);

// Cross-cellar (multi-select) views. `params` is a URLSearchParams string that
// must include `cellars=id1,id2,...` plus any search/filter params.
export const getMultiCellarBottles = (apiFetch, params = '') =>
  apiFetch(`/api/cellars/multi/bottles${params ? `?${params}` : ''}`);

export const getMultiCellarHistory = (apiFetch, params = '') =>
  apiFetch(`/api/cellars/multi/history${params ? `?${params}` : ''}`);

export const updateCellar = (apiFetch, id, data) =>
  apiFetch(`/api/cellars/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const deleteCellar = (apiFetch, id) =>
  apiFetch(`/api/cellars/${id}`, { method: 'DELETE' });

export const updateCellarColor = (apiFetch, id, color) =>
  apiFetch(`/api/cellars/${id}/color`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ color }),
  });

// Hand the cellar to another member. The outgoing owner stays on as an editor,
// so the "build it for someone, then give it to them" workflow keeps working.
export const transferCellarOwnership = (apiFetch, id, newOwnerId) =>
  apiFetch(`/api/cellars/${id}/transfer-ownership`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ newOwnerId }),
  });
