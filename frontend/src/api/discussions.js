import { JSON_HEADERS } from './apiConstants';

export const getDiscussions = (apiFetch, params = '') =>
  apiFetch(`/api/discussions${params ? `?${params}` : ''}`);

export const getDiscussion = (apiFetch, id) =>
  apiFetch(`/api/discussions/${id}`);

export const createDiscussion = (apiFetch, data) =>
  apiFetch('/api/discussions', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const updateDiscussion = (apiFetch, id, data) =>
  apiFetch(`/api/discussions/${id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data) });

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

export const toggleReplyLike = (apiFetch, discussionId, replyId) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}/like`, { method: 'POST' });

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

export const getCategories = (apiFetch) =>
  apiFetch('/api/discussions/categories');

export const getReplyOriginal = (apiFetch, discussionId, replyId) =>
  apiFetch(`/api/discussions/${discussionId}/replies/${replyId}/original`);

export const banUser = (apiFetch, userId, duration, reason) =>
  apiFetch('/api/discussions/moderation/ban', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ userId, duration, reason }) });

export const unbanUser = (apiFetch, userId) =>
  apiFetch(`/api/discussions/moderation/ban/${userId}`, { method: 'DELETE' });
