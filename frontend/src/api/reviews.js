import { JSON_HEADERS } from './apiConstants';

export const createReview = (apiFetch, data) =>
  apiFetch('/api/reviews', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const getWineReviews = (apiFetch, wineId, params = '') =>
  apiFetch(`/api/reviews/wine/${wineId}${params ? `?${params}` : ''}`);

export const getUserReviews = (apiFetch, userId, params = '') =>
  apiFetch(`/api/reviews/user/${userId}${params ? `?${params}` : ''}`);

export const getReviewFeed = (apiFetch, params = '') =>
  apiFetch(`/api/reviews/feed${params ? `?${params}` : ''}`);

export const getDiscoverFeed = (apiFetch, params = '') =>
  apiFetch(`/api/reviews/discover${params ? `?${params}` : ''}`);

export const getReview = (apiFetch, id) =>
  apiFetch(`/api/reviews/${id}`);

export const updateReview = (apiFetch, id, data) =>
  apiFetch(`/api/reviews/${id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const deleteReview = (apiFetch, id) =>
  apiFetch(`/api/reviews/${id}`, { method: 'DELETE' });

export const toggleLike = (apiFetch, id) =>
  apiFetch(`/api/reviews/${id}/like`, { method: 'POST' });
