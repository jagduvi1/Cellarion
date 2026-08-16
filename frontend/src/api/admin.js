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

// Wines sharing one canonical identity key (spelling/embed/tier variants
// collapsed). Distinct wineries CAN legitimately collide — that is why this
// is a review list, not an auto-merge.
export const adminGetCanonicalCollisions = (apiFetch) =>
  apiFetch('/api/admin/wines/canonical-collisions');

// SAME-WINE fragmentation the name-keyed nets can't see. mode=groups: records
// sharing an exact producer + appellation, disjoint-vintage sets first;
// mode=pairs: near-identical producer spellings inside one appellation.
export const adminGetWineFragmentation = (apiFetch, params) =>
  apiFetch(`/api/admin/wines/fragmentation?${params}`);

// Sommelier correction proposals: identity-field fixes, merges and non-wine
// flags filed from the maturity queue (MCP propose_wine_correction). The list
// is pending-first and its envelope carries pendingCount for the toolbar badge;
// approve applies the diff in one click, reject requires a reason.
export const adminGetWineProposals = (apiFetch, params) =>
  apiFetch(`/api/admin/wine-proposals?${params}`);

export const adminApproveWineProposal = (apiFetch, id) =>
  apiFetch(`/api/admin/wine-proposals/${id}/approve`, { method: 'POST' });

export const adminRejectWineProposal = (apiFetch, id, reason) =>
  apiFetch(`/api/admin/wine-proposals/${id}/reject`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ reason }),
  });

export const adminBulkApproveWineProposals = (apiFetch, ids) =>
  apiFetch('/api/admin/wine-proposals/bulk-approve', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ ids }),
  });

export const adminBulkRejectWineProposals = (apiFetch, ids, reason) =>
  apiFetch('/api/admin/wine-proposals/bulk-reject', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ ids, reason }),
  });

// Owner inquiries: questions sent to a wine's bottle owners (curator→owner
// channel for records only an owner can settle). The list is answered-first
// and its envelope carries pendingCount + answeredCount for the toolbar
// badge; resolve requires a note. Ask is somm-or-admin (lives under
// /api/admin/wines but is NOT admin-only server-side).
export const adminGetOwnerInquiries = (apiFetch, params) =>
  apiFetch(`/api/admin/owner-inquiries?${params}`);

/**
 * Resolve an inquiry. `note` is the curator record (required, admin-only);
 * `ownerReply` is optional and goes VERBATIM to every owner who answered.
 */
export const adminResolveOwnerInquiry = (apiFetch, id, note, ownerReply = '') =>
  apiFetch(`/api/admin/owner-inquiries/${id}/resolve`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ note, ownerReply }),
  });

export const adminAskOwnerInquiry = (apiFetch, wineId, question) =>
  apiFetch(`/api/admin/wines/${wineId}/owner-inquiry`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ question }),
  });

// Distinct wine-appellation strings no curated Appellation doc covers —
// the review queue that keeps free-text appellations honest.
export const adminGetUnmatchedAppellations = (apiFetch) =>
  apiFetch('/api/admin/taxonomy/appellations/unmatched');

/** Approve a user-minted region (clears its pendingReview flag). */
export const adminApproveRegion = (apiFetch, regionId) =>
  apiFetch(`/api/admin/taxonomy/regions/${regionId}/approve`, { method: 'POST' });

// Force a full Meilisearch rebuild from the running process — the restore
// runbook's missing step (a stale index silently disables the dedup net).
export const adminReindexSearch = (apiFetch) =>
  apiFetch('/api/admin/search/reindex', { method: 'POST' });

/** Merge one taxonomy doc into another. tab ∈ countries|regions|grapes. */
export const adminMergeTaxonomy = (apiFetch, tab, fromId, toId) =>
  apiFetch(`/api/admin/taxonomy/${tab}/merge`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ fromId, toId }),
  });

// The registry name-check scan (historical path name — it now runs every
// default rule in backend utils/nameChecks.js, not just producer-in-name).
export const adminGetProducerInNameWines = (apiFetch, params) =>
  apiFetch(`/api/admin/wines/producer-in-name?${params}`);

// Remove the wine's own producer prefix from its name.
export const adminStripProducerFromName = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}/strip-producer`, { method: 'POST' });

// Record that an admin read these wines and confirmed they pass these SPECIFIC
// name checks, so the scan stops surfacing them for those checks only.
// adminUnverify… reverses it (the undo).
// The "model in doubt" queue: wines whose enrichment confidence is at or
// below the threshold and not yet reviewed since their profile was generated.
export const adminGetLowConfidenceWines = (apiFetch, params) =>
  apiFetch(`/api/admin/wines/low-confidence?${params}`);

export const adminMarkProfileReviewed = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}/profile-reviewed`, { method: 'POST' });

export const adminUnmarkProfileReviewed = (apiFetch, id) =>
  apiFetch(`/api/admin/wines/${id}/profile-reviewed`, { method: 'DELETE' });

export const adminVerifyWineChecks = (apiFetch, wineIds, checks) =>
  apiFetch('/api/admin/wines/verify-checks', {
    method: 'POST', headers: J, body: JSON.stringify({ wineIds, checks }),
  });

export const adminUnverifyWineChecks = (apiFetch, wineIds, checks) =>
  apiFetch('/api/admin/wines/verify-checks', {
    method: 'DELETE', headers: J, body: JSON.stringify({ wineIds, checks }),
  });

// The cross-field domain scan: registry values sitting in the wrong FIELD
// (producer that is an appellation/region/country/grape/style term/
// placeholder, name⊂producer splits, …). Review queue — flags, never blocks.
export const adminGetCrossFieldChecks = (apiFetch, params) =>
  apiFetch(`/api/admin/wines/cross-field-checks?${params}`);

// Record (or undo) that an admin confirmed these wines' flagged values really
// belong in their fields, per rule id — the cross-field sibling of
// adminVerifyWineChecks, writing crossChecksCleared instead of verifiedChecks.
export const adminClearCrossChecks = (apiFetch, wineIds, checks) =>
  apiFetch('/api/admin/wines/cross-checks-clear', {
    method: 'POST', headers: J, body: JSON.stringify({ wineIds, checks }),
  });

export const adminUnclearCrossChecks = (apiFetch, wineIds, checks) =>
  apiFetch('/api/admin/wines/cross-checks-clear', {
    method: 'DELETE', headers: J, body: JSON.stringify({ wineIds, checks }),
  });

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

// Silent hard-delete (duplicate cleanup) — no uploader notification; starred /
// official references are handed to an identical surviving copy server-side.
export const adminDeleteImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}`, { method: 'DELETE' });

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

// Wine-centric curation: wines with 2+ images, and one-click set-official.
export const adminGetImagesByWine = (apiFetch, params) =>
  apiFetch(`/api/admin/images/by-wine?${params}`);

export const adminSetOfficialImage = (apiFetch, id) =>
  apiFetch(`/api/admin/images/${id}/set-official`, { method: 'PUT' });

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

// ── MCP (usage overview + kill switches) ─────────────────────────────────────
export const adminGetMcpUsage = (apiFetch, days = 30) =>
  apiFetch(`/api/admin/mcp/usage?days=${days}`);

// The kill switches live in the rateLimits config group; flipping them is a
// partial PATCH that leaves every other group untouched.
export const adminSetMcpSwitches = (apiFetch, { enabled, publicEnabled }) =>
  apiFetch('/api/admin/settings/rate-limits', {
    method: 'PATCH',
    headers: J,
    body: JSON.stringify({ mcp: { enabled, publicEnabled } }),
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

// ── AI budget requests (admin) ────────────────────────────────────────────────
export const adminGetAiBudgetRequests = (apiFetch, params) =>
  apiFetch(`/api/admin/ai-budget-requests?${params}`);

export const adminDecideAiBudgetRequest = (apiFetch, id, data) =>
  apiFetch(`/api/admin/ai-budget-requests/${id}`, {
    method: 'PATCH',
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
