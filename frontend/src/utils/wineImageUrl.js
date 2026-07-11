import { API_URL } from '../api/apiConstants';

/**
 * Resolves a wine image field value into a full URL.
 * Returns null when there is no image.
 *
 * Handles four formats stored in the DB:
 *  - Full external URL  ("http…")  → returned as-is
 *  - Inline data URL    ("data:…") → returned as-is
 *  - Internal API path  ("/api/…") → prefixed with API_URL
 *  - Plain filename     ("abc.png")→ prefixed with API_URL + /api/uploads/
 */
export function getWineImageUrl(image) {
  if (!image) return null;
  if (image.startsWith('http')) return image;
  if (image.startsWith('data:')) return image;
  if (image.startsWith('/api/')) return `${API_URL}${image}`;
  return `${API_URL}/api/uploads/${image}`;
}
