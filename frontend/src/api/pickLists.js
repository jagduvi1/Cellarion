import { JSON_HEADERS } from './apiConstants';

// Pick lists: named lists of the user's bottles to fetch, shown with cellar,
// rack and slot (backend routes/pickLists.js).

const post = (apiFetch, url, data) => apiFetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) });

export const getPickLists = (apiFetch) => apiFetch('/api/pick-lists');

export const getPickList = (apiFetch, id) => apiFetch(`/api/pick-lists/${id}`);

export const createPickList = (apiFetch, { name, bottleIds = [] }) =>
  post(apiFetch, '/api/pick-lists', { name, bottleIds });

export const renamePickList = (apiFetch, id, name) =>
  apiFetch(`/api/pick-lists/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name }) });

export const addToPickList = (apiFetch, id, bottleIds) =>
  post(apiFetch, `/api/pick-lists/${id}/items`, { bottleIds });

export const removeFromPickList = (apiFetch, id, bottleIds) =>
  post(apiFetch, `/api/pick-lists/${id}/items/remove`, { bottleIds });

export const setPicked = (apiFetch, id, bottleIds, picked) =>
  post(apiFetch, `/api/pick-lists/${id}/picked`, { bottleIds, picked });

export const deletePickList = (apiFetch, id) =>
  apiFetch(`/api/pick-lists/${id}`, { method: 'DELETE' });
