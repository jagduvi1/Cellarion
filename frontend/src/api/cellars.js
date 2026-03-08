const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const getCellar = (apiFetch, id, params = '') =>
  apiFetch(`/api/cellars/${id}${params ? `?${params}` : ''}`);

export const getCellarStatistics = (apiFetch, id, currency) =>
  apiFetch(`/api/cellars/${id}/statistics?currency=${currency}`);

export const getCellarAudit = (apiFetch, id) =>
  apiFetch(`/api/cellars/${id}/audit`);

export const getCellarHistory = (apiFetch, id) =>
  apiFetch(`/api/cellars/${id}/history`);

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
