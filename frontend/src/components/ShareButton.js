import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ShareButton.css';

/**
 * Renders a share button with a dropdown that lets users add a personal
 * message before sharing via social media, email, or copying the link.
 *
 * Props:
 *  - title:  share title (e.g. wine name)
 *  - text:   default share body text
 *  - url:    the URL to share (defaults to current page)
 *  - onRecommend: callback when "Recommend to a friend" is clicked
 */
export default function ShareButton({ title, text, url, onRecommend }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  const [message, setMessage] = useState('');
  const ref = useRef(null);

  const shareUrl = url || window.location.href;

  // Only use native share on mobile (touch devices) — Windows 11 exposes
  // navigator.share on desktop which gives a clunky OS dialog instead of
  // our custom dropdown with the recommend option.
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Reset message when dropdown opens
  useEffect(() => {
    if (open) setMessage('');
  }, [open]);

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

  // Build share text: user message + default text, or just default.
  // For X/Twitter the URL is passed separately, so keep text clean.
  const shareText = message.trim()
    ? `${message.trim()}\n\n${text || title || ''}`
    : (text || title || '');

  const handleCopy = async () => {
    const copyText = message.trim()
      ? `${message.trim()}\n\n${shareUrl}`
      : shareUrl;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = copyText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleIgCopy = async () => {
    const igText = [message.trim(), title, shareUrl].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(igText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = igText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setIgCopied(true);
    setTimeout(() => setIgCopied(false), 2000);
  };

  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(shareText);

  return (
    <div className="share-btn-wrap" ref={ref}>
      <button
        className="btn btn-small btn-secondary share-btn"
        onClick={handleClick}
        aria-label={t('share.share')}
        type="button"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        {t('share.share')}
      </button>

      {open && (
        <div className="share-dropdown">
          <div className="share-dropdown__message">
            <textarea
              className="share-dropdown__textarea"
              placeholder={t('share.addComment')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={280}
            />
          </div>

          <div className="share-dropdown__divider" />

          <button className="share-dropdown__item" onClick={handleCopy}>
            {copied ? t('share.copied') : t('share.copyLink')}
          </button>
          <a
            className="share-dropdown__item"
            href={`mailto:?subject=${encodeURIComponent(title || '')}&body=${encodedText}%0A%0A${encodedUrl}`}
            onClick={() => setOpen(false)}
          >
            {t('share.sendViaEmail')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            {t('share.shareOnX')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            {t('share.shareOnFacebook')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://wa.me/?text=${encodedText}%20${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            {t('share.shareOnWhatsApp')}
          </a>
          <button className="share-dropdown__item" onClick={handleIgCopy}>
            {igCopied ? t('share.copiedForInstagram') : t('share.copyForInstagram')}
          </button>
          {onRecommend && (
            <>
              <div className="share-dropdown__divider" />
              <button
                className="share-dropdown__item share-dropdown__item--recommend"
                onClick={() => { setOpen(false); onRecommend(); }}
              >
                {t('share.recommendToFriend')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
