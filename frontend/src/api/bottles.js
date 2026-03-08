const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const getBottle = (apiFetch, id) =>
  apiFetch(`/api/bottles/${id}`);

export const updateBottle = (apiFetch, id, data) =>
  apiFetch(`/api/bottles/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const consumeBottle = (apiFetch, id, data) =>
  apiFetch(`/api/bottles/${id}/consume`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const validateImport = (apiFetch, data) =>
  apiFetch('/api/bottles/import/validate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const confirmImport = (apiFetch, data) =>
  apiFetch('/api/bottles/import/confirm', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
