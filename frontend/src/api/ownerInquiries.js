import { JSON_HEADERS } from './apiConstants';

// Owner side of curator inquiries (see backend routes/ownerInquiries.js):
// the caller's own recipient view only — never other recipients' data.

/**
 * Active inquiries addressed to the caller, plus ones they ANSWERED that a
 * curator resolved in the last 30 days (those carry `curatorReply`); pass
 * wineId to scope to one wine.
 */
export const getMyOwnerInquiries = (apiFetch, wineId = null) =>
  apiFetch(`/api/owner-inquiries/mine${wineId ? `?wine=${wineId}` : ''}`);

/** One immutable answer per recipient — the server 409s a second attempt. */
export const respondToOwnerInquiry = (apiFetch, id, response) =>
  apiFetch(`/api/owner-inquiries/${id}/respond`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ response }),
  });
