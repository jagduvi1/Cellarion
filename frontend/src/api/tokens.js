import { JSON_HEADERS } from './apiConstants';

// Personal API tokens (Settings → API tokens). Scoped machine credentials for
// integrations like Home Assistant — see backend/src/routes/tokens.js.

// GET /api/tokens — [{ id, name, scopes, lastUsedAt, createdAt }]
export const listApiTokens = (apiFetch) => apiFetch('/api/tokens');

// POST /api/tokens — body: { name, scopes, password }. Returns { token, ... }
// where `token` is the plaintext shown exactly ONCE.
// Errors: 400 (validation / token cap), 401 (wrong password), 429 (auth limit).
export const createApiToken = (apiFetch, { name, scopes, password }) =>
  apiFetch('/api/tokens', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, scopes, password })
  });

// DELETE /api/tokens/:id — revoke; takes effect on the token's next request.
export const revokeApiToken = (apiFetch, id) =>
  apiFetch(`/api/tokens/${id}`, { method: 'DELETE' });
