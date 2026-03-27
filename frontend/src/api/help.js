/** Fetch help content — public endpoint, no auth needed. */
// Uses raw fetch (no apiFetch) because this is a public endpoint
// accessible without login. All other API modules use apiFetch.
export const getHelpContent = () =>
  fetch('/api/help').then(r => r.json());
