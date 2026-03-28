/**
 * Returns the URL if it uses a safe protocol (http/https), or null otherwise.
 * Prevents javascript: and data: URLs in user-supplied href attributes.
 */
export default function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return null;
}
