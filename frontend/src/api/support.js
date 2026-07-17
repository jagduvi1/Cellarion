import { JSON_HEADERS as J } from './apiConstants';

// ── Support Tickets (user-facing) ─────────────────────────────────────────────
export const submitSupportTicket = (apiFetch, data) =>
  apiFetch('/api/support', { method: 'POST', headers: J, body: JSON.stringify(data) });

export const getMySupportTickets = (apiFetch) =>
  apiFetch('/api/support/my');

export const replySupportTicket = (apiFetch, id, message) =>
  apiFetch(`/api/support/${id}/reply`, { method: 'POST', headers: J, body: JSON.stringify({ message }) });

// ── Wine Reports (user-facing) ────────────────────────────────────────────────
export const submitWineReport = (apiFetch, data) =>
  apiFetch('/api/wine-reports', { method: 'POST', headers: J, body: JSON.stringify(data) });

export const getMyWineReports = (apiFetch) =>
  apiFetch('/api/wine-reports/my');
