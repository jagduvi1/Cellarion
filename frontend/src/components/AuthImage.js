import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Renders an image whose URL may require a Bearer token.
 * Paths under /api/uploads are fetched via apiFetch (which sends the auth header)
 * and rendered as a blob: URL. External http(s) URLs are passed through unchanged.
 */
function AuthImage({ src, alt, className, onError, style }) {
  const { apiFetch } = useAuth();
  const [displaySrc, setDisplaySrc] = useState(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    if (!src) {
      setDisplaySrc(null);
      return;
    }

    // External or data URLs — no auth header needed
    if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('blob:')) {
      setDisplaySrc(src);
      return;
    }

    // Internal upload path — fetch with auth header
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
      onError={onError}
    />
  );
}

export default AuthImage;
