import { JSON_HEADERS } from './apiConstants';

// User-facing registry correction suggestions (#985 Slice A).
// Mirrors backend routes/wineProposals.js.

export const createWineProposal = (apiFetch, data) =>
  apiFetch('/api/wine-proposals', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const getMyWineProposals = (apiFetch, wineId) =>
  apiFetch(`/api/wine-proposals/mine?wine=${wineId}`);
