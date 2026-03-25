import { JSON_HEADERS } from './apiConstants';

export const getWishlist = (apiFetch, params = '') =>
  apiFetch(`/api/wishlist${params ? `?${params}` : ''}`);

export const addToWishlist = (apiFetch, data) =>
  apiFetch('/api/wishlist', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateWishlistItem = (apiFetch, id, data) =>
  apiFetch(`/api/wishlist/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const removeWishlistItem = (apiFetch, id) =>
  apiFetch(`/api/wishlist/${id}`, {
    method: 'DELETE',
  });
