import { JSON_HEADERS } from './apiConstants';

// AI-budget escalation flow (see backend/src/routes/aiBudget.js):
// status feeds the importer's "X of Y AI lookups used today" banner,
// request asks an admin for a temporary daily-limit increase.

export const getAiBudgetStatus = (apiFetch) =>
  apiFetch('/api/ai-budget/status');

export const requestAiBudgetIncrease = (apiFetch, data) =>
  apiFetch('/api/ai-budget/request', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
