export const listImportSessions = (apiFetch, cellarId) =>
  apiFetch(`/api/bottles/import/sessions?cellarId=${cellarId}`);

export const createImportSession = (apiFetch, data) =>
  apiFetch('/api/bottles/import/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

export const getImportSession = (apiFetch, sessionId) =>
  apiFetch(`/api/bottles/import/sessions/${sessionId}`);

export const updateImportSession = (apiFetch, sessionId, data) =>
  apiFetch(`/api/bottles/import/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

export const deleteImportSession = (apiFetch, sessionId) =>
  apiFetch(`/api/bottles/import/sessions/${sessionId}`, {
    method: 'DELETE'
  });
