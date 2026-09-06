import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Renders an image whose URL may require a Bearer token.
 *
 * - Paths under /api/uploads are passed through as plain <img src> (no auth
 *   needed — filenames are random UUIDs). This lets the browser cache them
 *   normally and avoids the fetch→blob→objectURL overhead.
 * - Other same-origin /api/ paths are fetched via apiFetch with the auth
 *   header and rendered as blob: URLs.
 * - External http(s), inline data:image and blob: URLs pass through unchanged.
 * - Anything else renders nothing. A registry wine.image is user-influenced
 *   data: a protocol-relative `//host/x`, a backslash variant or a leading
 *   space used to fall through to the authenticated branch and make every
 *   viewer's browser send its bearer token to that host (audit 2026-09
 *   S7-1 / F06-1 / F01-1).
 */
const API_PATH = /^\/api\/(?!\/)[^\\]*$/;
const PLAIN_SRC = /^(?:https?:\/\/[^\\\s]+|data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+|blob:[^\\\s]+)$/i;

function AuthImage({ src, alt, className, onError, style, loading }) {
  const { apiFetch } = useAuth();
  const [displaySrc, setDisplaySrc] = useState(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    if (!src) {
      setDisplaySrc(null);
      return;
    }

    // Not a same-origin API path: plain <img> for the shapes we recognise,
    // nothing at all for the rest — never an authenticated fetch.
    if (typeof src !== 'string' || !API_PATH.test(src)) {
      setDisplaySrc(typeof src === 'string' && PLAIN_SRC.test(src) ? src : null);
      return;
    }

    // Upload paths — served without auth, use direct src for browser caching
    if (src.startsWith('/api/uploads/')) {
      setDisplaySrc(src);
      return;
    }

    // Other same-origin API paths — fetch with auth header
    let cancelled = false;
    apiFetch(src)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.blob();
      })
      .then(blob => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setDisplaySrc(url);
      })
      .catch(() => {
        if (!cancelled) setDisplaySrc(null);
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!displaySrc) return null;

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      onError={onError}
    />
  );
}

export default AuthImage;
