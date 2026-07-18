import { JSON_HEADERS } from './apiConstants';

// POST /api/auth/change-password — body: { currentPassword, newPassword }.
// On success the backend invalidates all other sessions, rotates the refresh
// cookie for THIS browser and returns a fresh access token, so the current
// session keeps working via the normal apiFetch auto-refresh flow.
// Errors: 400 (policy violation / missing fields), 401 (wrong current
// password), 429 (auth rate limit).
export const changePassword = (apiFetch, { currentPassword, newPassword }) =>
  apiFetch('/api/auth/change-password', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ currentPassword, newPassword })
  });

// POST /api/auth/forgot-password — body: { email }. Deliberately plain fetch
// (the endpoint is unauthenticated): the login page uses it for forgotten
// passwords, and Settings reuses it so an SSO-only account can SET its first
// password through the same email-verified reset flow (SetPasswordNotice).
// The response is always the same generic 200 to prevent email enumeration.
export const requestPasswordReset = (email) =>
  fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email })
  });
