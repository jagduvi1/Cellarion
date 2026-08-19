import { JSON_HEADERS } from './apiConstants';

// Self-service analytics (#987). One query endpoint serves the table, the
// CSV export and (later) charts — the request shape is documented on
// backend/src/routes/analytics.js.

export const getAnalyticsCatalogue = (apiFetch) => apiFetch('/api/analytics/catalogue');

export const runAnalyticsQuery = (apiFetch, query) =>
  apiFetch('/api/analytics/query', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(query),
  });

// Dashboard (#987 R-E): one per user; null until first customized.
export const getDashboard = (apiFetch) => apiFetch('/api/analytics/dashboard');

export const saveDashboard = (apiFetch, widgets) =>
  apiFetch('/api/analytics/dashboard', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ widgets }),
  });
