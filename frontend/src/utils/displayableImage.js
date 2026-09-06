import safeUrl from './safeUrl';

/**
 * A requester (any user) chose this value. Only three shapes are ever put into
 * an <img>, offered to an approval form or rendered as a link: one of our own
 * upload paths, an inline image, or an http(s) URL. Everything else — a
 * protocol-relative "//host", javascript:, a bare word — yields null
 * (audit 2026-09 F06-1 / F06-2 / F06-3). Mirrors validateImageRef on the server.
 */
const UPLOAD_PATH = /^\/api\/uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const DOT_SEGMENT = /\/\.\.?(?:\/|$)/;
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export default function displayableImage(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (UPLOAD_PATH.test(v) && !DOT_SEGMENT.test(v)) return v;
  if (INLINE_IMAGE.test(v)) return v;
  return safeUrl(v);
}
