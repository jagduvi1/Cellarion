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

// Dashboards (#987): several named boards per user.
export const listDashboards = (apiFetch) => apiFetch('/api/analytics/dashboards');

export const createDashboard = (apiFetch, name, widgets = []) =>
  apiFetch('/api/analytics/dashboards', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, widgets }),
  });

export const updateDashboard = (apiFetch, id, patch) =>
  apiFetch(`/api/analytics/dashboards/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });

export const deleteDashboard = (apiFetch, id) =>
  apiFetch(`/api/analytics/dashboards/${id}`, { method: 'DELETE' });

// Saved views + preset stars (#987 saved-views slice).
export const listViews = (apiFetch) => apiFetch('/api/analytics/views');

export const saveView = (apiFetch, view) =>
  apiFetch('/api/analytics/views', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(view),
  });

export const updateView = (apiFetch, id, patch) =>
  apiFetch(`/api/analytics/views/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });

export const deleteView = (apiFetch, id) =>
  apiFetch(`/api/analytics/views/${id}`, { method: 'DELETE' });

export const starPreset = (apiFetch, presetKey) =>
  apiFetch('/api/analytics/views/star-preset', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ presetKey }),
  });
