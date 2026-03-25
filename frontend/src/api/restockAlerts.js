export const getRestockAlerts = (apiFetch, status = 'active') =>
  apiFetch(`/api/restock-alerts?status=${status}`);

export const dismissRestockAlert = (apiFetch, id) =>
  apiFetch(`/api/restock-alerts/${id}/dismiss`, { method: 'PUT' });
