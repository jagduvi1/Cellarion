const JSON_HEADERS = { 'Content-Type': 'application/json' };

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
