const J = { 'Content-Type': 'application/json' };

// ── Wines ────────────────────────────────────────────────────────────────────
export const adminGetWines = (apiFetch, params) =>
  apiFetch(`/api/admin/wines?${params}`);

export const adminGetWine = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}`);

export const adminSaveWine = (apiFetch, data, id = null) =>
  apiFetch(id ? `/api/admin/wines/${id}` : '/api/admin/wines', {
    method: id ? 'PUT' : 'POST',
    headers: J,
    body: JSON.stringify(data),
  });

export const adminDeleteWine = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}`, { method: 'DELETE' });

// ── Taxonomy ─────────────────────────────────────────────────────────────────
export const adminGetTaxonomy = (apiFetch, endpoint) =>
  apiFetch(endpoint);

export const adminGetCountries = (apiFetch) =>
  apiFetch('/api/admin/taxonomy/countries');

export const adminGetGrapes = (apiFetch) =>
  apiFetch('/api/admin/taxonomy/grapes');

export const adminGetRegions = (apiFetch, countryId) =>
  apiFetch(`/api/admin/taxonomy/regions?country=${countryId}`);

export const adminGetAppellations = (apiFetch, params) =>
  apiFetch(`/api/admin/taxonomy/appellations?${params}`);

export const adminCreateTaxonomy = (apiFetch, endpoint, data) =>
  apiFetch(endpoint, { method: 'POST', headers: J, body: JSON.stringify(data) });

export const adminUpdateTaxonomy = (apiFetch, endpoint, id, data) =>
  apiFetch(`${endpoint}/${id}`, { method: 'PUT', headers: J, body: JSON.stringify(data) });

export const adminDeleteTaxonomy = (apiFetch, endpoint, id) =>
  apiFetch(`${endpoint}/${id}`, { method: 'DELETE' });

// ── Wine Requests ─────────────────────────────────────────────────────────────
export const adminGetWineRequests = (apiFetch, params) =>
  apiFetch(`/api/admin/wine-requests${params}`);

export const adminResolveWineRequest = (apiFetch, id, data) =>
  apiFetch(`/api/admin/wine-requests/${id}/resolve`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify(data),
  });

export const adminRejectWineRequest = (apiFetch, id, data) =>
  apiFetch(`/api/admin/wine-requests/${id}/reject`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify(data),
  });

// ── Users ─────────────────────────────────────────────────────────────────────
export const adminGetUsers = (apiFetch, params) =>
  apiFetch(`/api/admin/users?${params}`);

export const adminChangeUserPlan = (apiFetch, userId, plan, expiresInDays) =>
  apiFetch(`/api/admin/users/${userId}/plan`, {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify({ plan, expiresInDays }),
  });

export const adminResetUserTrial = (apiFetch, userId) =>
  apiFetch(`/api/admin/users/${userId}/trial-eligible`, { method: 'PATCH', headers: J });

export const adminChangeUserRoles = (apiFetch, userId, roles) =>
  apiFetch(`/api/admin/users/${userId}/roles`, {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify({ roles }),
  });

// ── Audit ─────────────────────────────────────────────────────────────────────
export const adminGetAudit = (apiFetch, params) =>
  apiFetch(`/api/admin/audit?${params}`);

// ── Images ────────────────────────────────────────────────────────────────────
export const adminGetImages = (apiFetch, params) =>
  apiFetch(`/api/admin/images?${params}`);

export const adminApproveImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}/approve`, { method: 'PUT' });

export const adminRejectImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}/reject`, { method: 'PUT' });

export const adminAssignImageToWine = (apiFetch, id, data) =>
  apiFetch(`/api/admin/images/${id}/assign-to-wine`, {
    method: 'PUT',
    headers: J,
    body: JSON.stringify(data),
  });

// ── Import ────────────────────────────────────────────────────────────────────
export const adminImportWines = (apiFetch, body) =>
  apiFetch('/api/admin/import/wines', { method: 'POST', body });

// ── Settings (rate limits — used by SuperAdmin) ───────────────────────────────
export const adminGetRateLimits = (apiFetch) =>
  apiFetch('/api/admin/settings/rate-limits');

export const adminSaveRateLimits = (apiFetch, data) =>
  apiFetch('/api/admin/settings/rate-limits', {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify(data),
  });
