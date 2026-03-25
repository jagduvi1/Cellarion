import { JSON_HEADERS } from './apiConstants';

export const getRecommendations = (apiFetch, params = '') =>
  apiFetch(`/api/recommendations${params ? `?${params}` : ''}`);

export const getSentRecommendations = (apiFetch, params = '') =>
  apiFetch(`/api/recommendations/sent${params ? `?${params}` : ''}`);

export const sendRecommendation = (apiFetch, data) =>
  apiFetch('/api/recommendations', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateRecommendationStatus = (apiFetch, id, status) =>
  apiFetch(`/api/recommendations/${id}/status`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });

export const searchFriends = (apiFetch, q = '') =>
  apiFetch(`/api/recommendations/friends${q ? `?q=${encodeURIComponent(q)}` : ''}`);
