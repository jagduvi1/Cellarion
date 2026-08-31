import { JSON_HEADERS } from './apiConstants';

export const getDiscussions = (apiFetch, params = '') =>
  apiFetch(`/api/discussions${params ? `?${params}` : ''}`);

export const getDiscussion = (apiFetch, id) =>
  apiFetch(`/api/discussions/${id}`);

export const createDiscussion = (apiFetch, data) =>
  apiFetch('/api/discussions', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const deleteDiscussion = (apiFetch, id) =>
  apiFetch(`/api/discussions/${id}`, { method: 'DELETE' });

export const getDiscussionReplies = (apiFetch, discussionId, params = '') =>
  apiFetch(`/api/discussions/${discussionId}/replies${params ? `?${params}` : ''}`);

export const createReply = (apiFetch, discussionId, data) =>
  apiFetch(`/api/discussions/${discussionId}/replies`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const updateReply = (apiFetch, discussionId, replyId, data) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const deleteReply = (apiFetch, discussionId, replyId) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}`, { method: 'DELETE' });

// Toggle a reaction kind on a reply. The backend treats the same kind twice
// as a flip (off), and different kinds as independent reactions.
export const toggleReaction = (apiFetch, discussionId, replyId, kind) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}/reactions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ kind })
  });

// Follow / unfollow a thread. Auto-follow happens server-side when you post
// or reply; this endpoint is only used by the manual Follow button on
// threads you didn't author.
export const watchDiscussion = (apiFetch, idOrSlug) =>
  apiFetch(`/api/discussions/${idOrSlug}/watch`, { method: 'POST' });

export const unwatchDiscussion = (apiFetch, idOrSlug) =>
  apiFetch(`/api/discussions/${idOrSlug}/watch`, { method: 'DELETE' });

export const pinDiscussion = (apiFetch, id) =>
  apiFetch(`/api/discussions/${id}/pin`, { method: 'PATCH' });

export const lockDiscussion = (apiFetch, id) =>
  apiFetch(`/api/discussions/${id}/lock`, { method: 'PATCH' });

export const moveDiscussion = (apiFetch, id, category) =>
  apiFetch(`/api/discussions/${id}/move`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ category }) });

export const reportDiscussion = (apiFetch, id, data) =>
  apiFetch(`/api/discussions/${id}/report`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const reportReply = (apiFetch, discussionId, replyId, data) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}/report`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const getModerationReports = (apiFetch, params = '') =>
  apiFetch(`/api/discussions/moderation/reports${params ? `?${params}` : ''}`);

export const resolveReport = (apiFetch, reportId, status) =>
  apiFetch(`/api/discussions/moderation/reports/${reportId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ status }) });

export const getReplyOriginal = (apiFetch, discussionId, replyId) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}/original`);

export const banUser = (apiFetch, userId, duration, reason) =>
  apiFetch('/api/discussions/moderation/ban', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ userId, duration, reason }) });

export const unbanUser = (apiFetch, userId) =>
  apiFetch(`/api/discussions/moderation/ban/${userId}`, { method: 'DELETE' });

// ── Forum language sections ─────────────────────────────────────────────────
// English is the forum's default section; everything else is opened by a
// moderator. See backend services/forumLanguages for the policy.

/** The sections a member can post in (English first). Anonymous-readable. */
export const getForumLanguages = (apiFetch) =>
  apiFetch('/api/forum-languages');

/** Ask for a section that isn't open yet. */
export const requestForumLanguage = (apiFetch, data) =>
  apiFetch('/api/forum-languages/requests', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

/** Moderator: the pending requests + retired sections. */
export const getForumLanguageRequests = (apiFetch) =>
  apiFetch('/api/forum-languages/requests');

/** Moderator: approve | reject | retire a section. */
export const decideForumLanguage = (apiFetch, code, action, note) =>
  apiFetch(`/api/forum-languages/${code}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ action, note }),
  });

/** Moderator: move a mis-filed thread into another language section. */
export const moveDiscussionLanguage = (apiFetch, idOrSlug, language) =>
  apiFetch(`/api/discussions/${idOrSlug}/language`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ language }),
  });
