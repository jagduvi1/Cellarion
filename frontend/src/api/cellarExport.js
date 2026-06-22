// Client for the Cellarion-format cellar export (/api/users/me/*-export).
// `scope` is a cellar id or the string 'all'. The summary powers the
// "see your total export" panel; the two download calls return the file blob.

export const getExportSummary = (apiFetch, scope = 'all') =>
  apiFetch(`/api/users/me/export-summary?cellar=${encodeURIComponent(scope)}`);

export const downloadDataExport = (apiFetch, scope = 'all') =>
  apiFetch(`/api/users/me/data-export?cellar=${encodeURIComponent(scope)}`);

export const downloadFullExport = (apiFetch, scope = 'all') =>
  apiFetch(`/api/users/me/full-export?cellar=${encodeURIComponent(scope)}`);
