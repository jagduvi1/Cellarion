import { useState, useRef, useEffect } from 'react';
import './ShareButton.css';

/**
 * Renders a share button that uses the native Web Share API on supported
 * devices (mobile) and falls back to a dropdown with copy-link + social
 * intent URLs on desktop.
 *
 * Props:
 *  - title:  share title (e.g. wine name)
 *  - text:   share body text
 *  - url:    the URL to share (defaults to current page)
 *  - onRecommend: callback when "Recommend to a friend" is clicked
 */
export default function ShareButton({ title, text, url, onRecommend }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  const shareUrl = url || window.location.href;

  // Only use native share on mobile (touch devices) — Windows 11 exposes
  // navigator.share on desktop which gives a clunky OS dialog instead of
  // our custom dropdown with the recommend option.
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleClick = async () => {
    // Use native share only on mobile devices
    if (isMobile && navigator.share) {
      try {
        await navigator.share({ title, text, url: shareUrl });
        return;
      } catch {
        // User cancelled or not supported — fall through to dropdown
      }
    }
    setOpen((prev) => !prev);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(text || title || '');

  return (
    <div className="share-btn-wrap" ref={ref}>
      <button
        className="btn btn-small btn-secondary share-btn"
        onClick={handleClick}
        aria-label="Share"
        type="button"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        Share
      </button>

      {open && (
        <div className="share-dropdown">
          <button className="share-dropdown__item" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
          <a
            className="share-dropdown__item"
            href={`https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            Share on X
          </a>
          <a
            className="share-dropdown__item"
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            Share on Facebook
          </a>
          <a
            className="share-dropdown__item"
            href={`https://wa.me/?text=${encodedText}%20${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            Share on WhatsApp
          </a>
          {onRecommend && (
            <>
              <div className="share-dropdown__divider" />
              <button
                className="share-dropdown__item share-dropdown__item--recommend"
                onClick={() => { setOpen(false); onRecommend(); }}
              >
                Recommend to a friend
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
