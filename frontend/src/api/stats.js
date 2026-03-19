export function getStatsOverview(apiFetch) {
  return apiFetch('/api/stats/overview');
}

export function getValueHistory(apiFetch, months = 12) {
  return apiFetch(`/api/stats/value-history?months=${months}`);
}
