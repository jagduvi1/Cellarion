export const followUser = (apiFetch, userId) =>
  apiFetch(`/api/follows/${userId}`, { method: 'POST' });

export const unfollowUser = (apiFetch, userId) =>
  apiFetch(`/api/follows/${userId}`, { method: 'DELETE' });

export const getFollowers = (apiFetch, userId, params = '') =>
  apiFetch(`/api/follows/${userId}/followers${params ? `?${params}` : ''}`);

export const getFollowing = (apiFetch, userId, params = '') =>
  apiFetch(`/api/follows/${userId}/following${params ? `?${params}` : ''}`);
