import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Renders an image whose URL may require a Bearer token.
 *
 * - Paths under /api/uploads are passed through as plain <img src> (no auth
 *   needed — filenames are random UUIDs). This lets the browser cache them
 *   normally and avoids the fetch→blob→objectURL overhead.
 * - Other internal /api/ paths are still fetched via apiFetch with the auth
 *   header and rendered as blob: URLs.
 * - External http(s)/data:/blob: URLs pass through unchanged.
 */
function AuthImage({ src, alt, className, onError, style, loading }) {
  const { apiFetch } = useAuth();
  const [displaySrc, setDisplaySrc] = useState(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    if (!src) {
      setDisplaySrc(null);
      return;
    }

    // External, data, or blob URLs — no auth needed
    if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('blob:')) {
      setDisplaySrc(src);
      return;
    }

    // Upload paths — served without auth, use direct src for browser caching
    if (src.startsWith('/api/uploads')) {
      setDisplaySrc(src);
      return;
    }

    // Other internal paths — fetch with auth header
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
