import { JSON_HEADERS } from './apiConstants';

// Registry Bridge keys (Settings → Connect a self-hosted Cellarion). Account-
// bound `cbr_` keys a self-hosted install uses to reach the shared registry —
// see backend/src/routes/bridgeKeys.js and docs/registry-bridge.md.

// GET /api/bridge/keys — { keys: [...], maxActive, terms: { version, accepted, url } }
export const listBridgeKeys = (apiFetch) => apiFetch('/api/bridge/keys');

// POST /api/bridge/keys — body: { name, password, acceptTerms }. Returns
// { key, id, name, prefix, env } where `key` is the plaintext shown ONCE.
// Errors: 400 (validation / terms_required / key_cap), 403 (wrong password —
// NOT 401, which apiFetch would treat as session expiry), 429 (auth limit).
export const createBridgeKey = (apiFetch, { name, password, acceptTerms }) =>
  apiFetch('/api/bridge/keys', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, password, acceptTerms }),
  });

// DELETE /api/bridge/keys/:id — revoke; takes effect on the key's next request.
export const revokeBridgeKey = (apiFetch, id) =>
  apiFetch(`/api/bridge/keys/${id}`, { method: 'DELETE' });

// POST /api/bridge/keys/:id/import-window — ×5 quotas for 24 h, once per 30 days.
export const openBridgeImportWindow = (apiFetch, id) =>
  apiFetch(`/api/bridge/keys/${id}/import-window`, { method: 'POST' });
