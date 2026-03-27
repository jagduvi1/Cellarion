/** Fetch help content (public, no auth needed). */
export const getHelpContent = () =>
  fetch('/api/help').then(r => r.json());
