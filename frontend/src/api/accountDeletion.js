import { JSON_HEADERS } from './apiConstants';

// The "delete my account" link in our emails (backend utils/accountDeletionLink)
// opens pages/DeleteAccountLink, which asks these two. Plain fetch: whoever
// opens the mail is usually not logged in on that device. The token goes in
// the body, never the URL. Both answer 400 { code: 'LINK_INVALID' } for a bad,
// expired or foreign link.

// POST /api/users/delete-account/preview — body { token }.
// → { username, bottles, supporter, deletionScheduledFor }
export const previewAccountDeletion = (token) =>
  fetch('/api/users/delete-account/preview', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token })
  });

// POST /api/users/delete-account — body { token }. Schedules the same 7-day
// deletion as Settings. → { deletionScheduledFor, alreadyScheduled? }
export const confirmAccountDeletion = (token) =>
  fetch('/api/users/delete-account', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token })
  });
