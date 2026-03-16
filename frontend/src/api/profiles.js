import { JSON_HEADERS } from './apiConstants';

export const getPublicProfile = (apiFetch, userId) =>
  apiFetch(`/api/users/public/${userId}`);

export const updateProfile = (apiFetch, data) =>
  apiFetch('/api/users/profile', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const searchUsers = (apiFetch, query) =>
  apiFetch(`/api/users/search?q=${encodeURIComponent(query)}`);
