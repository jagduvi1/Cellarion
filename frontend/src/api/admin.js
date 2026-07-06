import { JSON_HEADERS as J } from './apiConstants';

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

export const adminMergeWine = (apiFetch, sourceId, targetId) =>
  apiFetch(`/api/admin/wines/${sourceId}/merge`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ targetId }),
  });

// "Golden record" merge: absorb every sourceIds wine into keeperId in one call.
// The keeper's composed field values are saved separately (adminSaveWine) first;
// imageFromWineId names which wine's photo the merged record should keep.
export const adminMergeCluster = (apiFetch, { keeperId, sourceIds, imageFromWineId }) =>
  apiFetch('/api/admin/wines/merge', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ keeperId, sourceIds, imageFromWineId }),
  });

export const adminGetWineDuplicateClusters = (apiFetch, { minScore = 0.6, limit = 50 } = {}) =>
  apiFetch(`/api/admin/wines/duplicate-clusters?minScore=${minScore}&limit=${limit}`);

// Mark a cluster's wines as NOT the same wine, so the scanner stops surfacing
// them. adminUndismiss… reverses it (the undo).
export const adminDismissDuplicateCluster = (apiFetch, wineIds) =>
  apiFetch('/api/admin/wines/dismiss-duplicates', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ wineIds }),
  });

export const adminUndismissDuplicateCluster = (apiFetch, wineIds) =>
  apiFetch('/api/admin/wines/dismiss-duplicates', {
    method: 'DELETE',
    headers: J,
    body: JSON.stringify({ wineIds }),
  });

// Wines whose name starts with their own producer (AI-import artefacts).
export const adminGetProducerInNameWines = (apiFetch, params) =>
  apiFetch(`/api/admin/wines/producer-in-name?${params}`);

// Remove the wine's own producer prefix from its name.
export const adminStripProducerFromName = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}/strip-producer`, { method: 'POST' });

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
    method: 'PUT',
    headers: J,
    body: JSON.stringify(data),
  });

export const adminRejectWineRequest = (apiFetch, id, data) =>
  apiFetch(`/api/admin/wine-requests/${id}/reject`, {
    method: 'PUT',
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

export const adminApproveImage = (apiFetch, id, data = {}) =>
  apiFetch(`/api/admin/images/${id}/approve`, { method: 'PUT', headers: J, body: JSON.stringify(data) });

export const adminRejectImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}/reject`, { method: 'PUT' });

export const adminSetImageVisibility = (apiFetch, id, visibility) =>
  apiFetch(`/api/admin/images/${id}/visibility`, { method: 'PUT', headers: J, body: JSON.stringify({ visibility }) });

export const adminUnapproveImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}/unapprove`, { method: 'PUT' });

export const adminAssignImageToWine = (apiFetch, id, data) =>
  apiFetch(`/api/admin/images/${id}/assign-to-wine`, {
    method: 'PUT',
    headers: J,
    body: JSON.stringify(data),
  });

// ── Import ────────────────────────────────────────────────────────────────────
export const adminImportWines = (apiFetch, body) =>
  apiFetch('/api/admin/import/wines', { method: 'POST', body });

// ── Security summary (used by SuperAdmin nav badge) ───────────────────────────
export const adminGetSecuritySummary = (apiFetch) =>
  apiFetch('/api/admin/security/summary');

// ── Announcement banner (SuperAdmin) ──────────────────────────────────────────
export const superadminGetAnnouncement = (apiFetch) =>
  apiFetch('/api/superadmin/announcement');

export const superadminSaveAnnouncement = (apiFetch, data) =>
  apiFetch('/api/superadmin/announcement', {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify(data),
  });

// ── Settings (rate limits — used by SuperAdmin) ───────────────────────────────
export const adminGetRateLimits = (apiFetch) =>
  apiFetch('/api/admin/settings/rate-limits');

export const adminSaveRateLimits = (apiFetch, data) =>
  apiFetch('/api/admin/settings/rate-limits', {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify(data),
  });

// ── Cellars (deleted / restore) ───────────────────────────────────────────────
export const adminGetDeletedCellars = (apiFetch, params) =>
  apiFetch(`/api/admin/cellars/deleted?${params}`);

export const adminRestoreCellar = (apiFetch, id) =>
  apiFetch(`/api/admin/cellars/${id}/restore`, { method: 'POST' });

export const adminPermanentDeleteCellar = (apiFetch, id) =>
  apiFetch(`/api/admin/cellars/${id}`, { method: 'DELETE' });

// ── Support Tickets (admin) ───────────────────────────────────────────────────
export const adminGetSupportTickets = (apiFetch, params) =>
  apiFetch(`/api/admin/support-tickets?${params}`);

export const adminRespondToTicket = (apiFetch, id, data) =>
  apiFetch(`/api/admin/support-tickets/${id}/respond`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

export const adminUpdateTicketStatus = (apiFetch, id, status) =>
  apiFetch(`/api/admin/support-tickets/${id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

// ── Wine Reports (admin) ──────────────────────────────────────────────────────
export const adminGetWineReports = (apiFetch, params) =>
  apiFetch(`/api/admin/wine-reports?${params}`);

export const adminResolveWineReport = (apiFetch, id, data) =>
  apiFetch(`/api/admin/wine-reports/${id}/resolve`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

export const adminDismissWineReport = (apiFetch, id, data) =>
  apiFetch(`/api/admin/wine-reports/${id}/dismiss`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

// ── Global stats (admin overview across all users) ───────────────────────────
// Admins are excluded by DEFAULT (the dashboard should reflect real customers).
// Always send the flag explicitly so unchecking the toggle (include admins)
// sends excludeAdmins=false rather than omitting it and falling back to the
// server default of true.
export const adminGetGlobalStats = (apiFetch, { excludeAdmins = true, force = false } = {}) => {
  const params = new URLSearchParams();
  params.set('excludeAdmins', excludeAdmins ? 'true' : 'false');
  if (force) params.set('force', 'true');
  return apiFetch(`/api/admin/stats/global?${params.toString()}`);
};

// ── Settings (contact email) ──────────────────────────────────────────────────
export const adminGetContactEmail = (apiFetch) =>
  apiFetch('/api/admin/settings/contact-email');

export const adminSaveContactEmail = (apiFetch, contactEmail) =>
  apiFetch('/api/admin/settings/contact-email', {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify({ contactEmail }),
  });
