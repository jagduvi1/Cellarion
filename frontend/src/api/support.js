const J = { 'Content-Type': 'application/json' };

// ── Support Tickets (user-facing) ─────────────────────────────────────────────
export const submitSupportTicket = (apiFetch, data) =>
  apiFetch('/api/support', { method: 'POST', headers: J, body: JSON.stringify(data) });

export const getMySupportTickets = (apiFetch) =>
  apiFetch('/api/support/my');

// ── Wine Reports (user-facing) ────────────────────────────────────────────────
export const submitWineReport = (apiFetch, data) =>
  apiFetch('/api/wine-reports', { method: 'POST', headers: J, body: JSON.stringify(data) });

export const getMyWineReports = (apiFetch) =>
  apiFetch('/api/wine-reports/my');
