import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './JumpToReplyButton.css';

// Floating "Reply" button anchored to the bottom-right of the viewport.
// Visible only while the composer is OFF-SCREEN — the moment the user
// scrolls the composer into view (or it's already visible on a short
// thread), the button hides so we don't double-promise the affordance.
//
// Click → smooth-scrolls the composer into view and focuses its
// contenteditable so the user can start typing immediately.
//
// Renders nothing for anon users (the composer isn't shown to them anyway)
// or when the composer ref hasn't been attached yet.
export default function JumpToReplyButton({ composerRef, enabled = true }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = composerRef?.current;
    if (!enabled || !target || typeof IntersectionObserver === 'undefined') {
      setVisible(false);
      return undefined;
    }

    const io = new IntersectionObserver(
      (entries) => {
        // Hide the button when ≥ 30% of the composer is visible. The 30%
        // threshold (vs 0%) avoids a flicker right at the edge — once the
        // user can meaningfully see the composer, we trust they don't need
        // a separate jump button.
        const composerVisible = entries.some(e => e.isIntersecting && e.intersectionRatio >= 0.3);
        setVisible(!composerVisible);
      },
      { threshold: [0, 0.3, 1] }
    );
    io.observe(target);
    return () => io.disconnect();
  }, [composerRef, enabled]);

  if (!enabled || !visible) return null;

  const handleClick = () => {
    const target = composerRef?.current;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus the TipTap editor inside the composer once the scroll has had
    // a moment to settle (~400ms covers the smooth-scroll easing curve).
    setTimeout(() => {
      const editable = target.querySelector('.ProseMirror');
      if (editable) editable.focus();
    }, 400);
  };

  return (
    <button
      type="button"
      className="jump-to-reply-btn"
      onClick={handleClick}
      aria-label={t('discussions.jumpToReply')}
      title={t('discussions.jumpToReply')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span className="jump-to-reply-btn__label">{t('discussions.replyShort')}</span>
    </button>
  );
}
