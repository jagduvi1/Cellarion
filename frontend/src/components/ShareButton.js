import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ShareButton.css';

/**
 * Share button with dropdown. Always shows our custom dropdown on all devices.
 * "Share via apps" triggers the native OS share sheet when available.
 */
export default function ShareButton({ title, text, url, onRecommend, variant, className }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [igCopied, setIgCopied] = useState(false);
  const [message, setMessage] = useState('');
  const ref = useRef(null);

  const shareUrl = url || window.location.href;
  const hasNativeShare = !!navigator.share;

  useEffect(() => {
    if (open) { setMessage(''); setCopied(false); setIgCopied(false); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const shareText = message.trim()
    ? `${message.trim()}\n\n${text || title || ''}`
    : (text || title || '');

  const copyToClipboard = async (val) => {
    try { await navigator.clipboard.writeText(val); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = val;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  const handleCopy = async () => {
    const copyText = message.trim() ? `${message.trim()}\n\n${shareUrl}` : shareUrl;
    await copyToClipboard(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleIgCopy = async () => {
    await copyToClipboard([message.trim(), title, shareUrl].filter(Boolean).join('\n\n'));
    setIgCopied(true);
    setTimeout(() => setIgCopied(false), 2000);
  };

  const handleNativeShare = async () => {
    try {
      await navigator.share({ title, text: shareText, url: shareUrl });
    } catch { /* cancelled */ }
    setOpen(false);
  };

  const encodedUrl = encodeURIComponent(shareUrl);
  const isIcon = variant === 'icon';

  return (
    <div className={`share-btn-wrap ${className || ''}`} ref={ref}>
      <button
        className={isIcon ? 'share-icon-btn' : 'btn btn-small btn-secondary share-btn'}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t('share.share')}
        type="button"
      >
        <svg width={isIcon ? 18 : 16} height={isIcon ? 18 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        {!isIcon && t('share.share')}
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

          {/* Share via native OS sheet */}
          {hasNativeShare && (
            <button className="share-dropdown__item" onClick={handleNativeShare}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
              {t('share.shareViaApps', 'Share via apps')}
            </button>
          )}

          <button className="share-dropdown__item" onClick={handleCopy}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            {copied ? t('share.copied') : t('share.copyLink')}
          </button>

          <div className="share-dropdown__divider" />

          <a
            className="share-dropdown__item"
            href={`mailto:?subject=${encodeURIComponent(title || '')}&body=${encodeURIComponent(shareText)}%0A%0A${encodedUrl}`}
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            {t('share.sendViaEmail')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            {t('share.shareOnX')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            {t('share.shareOnFacebook')}
          </a>
          <a
            className="share-dropdown__item"
            href={`https://wa.me/?text=${encodeURIComponent(shareText)}%20${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            {t('share.shareOnWhatsApp')}
          </a>
          <button className="share-dropdown__item" onClick={handleIgCopy}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
            {igCopied ? t('share.copiedForInstagram') : t('share.copyForInstagram')}
          </button>

          {onRecommend && (
            <>
              <div className="share-dropdown__divider" />
              <button
                className="share-dropdown__item share-dropdown__item--recommend"
                onClick={() => { setOpen(false); onRecommend(); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                {t('share.recommendToFriend')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
