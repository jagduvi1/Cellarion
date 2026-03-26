import { JSON_HEADERS } from './apiConstants';

export const askGuide = (apiFetch, question, currentPage) =>
  apiFetch('/api/guide/ask', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ question, currentPage }),
  });
