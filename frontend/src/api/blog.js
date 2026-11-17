import { JSON_HEADERS } from './apiConstants';

// ── Public ──

export const getBlogPosts = (apiFetch, { page = 1, limit = 12, tag, q } = {}) => {
  const params = new URLSearchParams({ page, limit });
  if (tag) params.set('tag', tag);
  if (q) params.set('q', q);
  return apiFetch(`/api/blog?${params}`);
};

export const getBlogPost = (apiFetch, slug) =>
  apiFetch(`/api/blog/${slug}`);

export const getBlogTags = (apiFetch) =>
  apiFetch('/api/blog/tags');

// ── Admin ──

export const getAdminBlogPosts = (apiFetch, { page = 1, limit = 20, status } = {}) => {
  const params = new URLSearchParams({ page, limit });
  if (status) params.set('status', status);
  return apiFetch(`/api/blog/admin/posts?${params}`);
};

export const getAdminBlogPost = (apiFetch, id) =>
  apiFetch(`/api/blog/admin/posts/${id}`);

// The posts a translation can point at, for the editor's "Translation of" list.
export const getAdminBlogOriginals = (apiFetch) =>
  apiFetch('/api/blog/admin/originals');

export const createBlogPost = (apiFetch, data) =>
  apiFetch('/api/blog/admin/posts', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const updateBlogPost = (apiFetch, id, data) =>
  apiFetch(`/api/blog/admin/posts/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

export const deleteBlogPost = (apiFetch, id) =>
  apiFetch(`/api/blog/admin/posts/${id}`, {
    method: 'DELETE',
  });
