import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useGuide } from '../contexts/GuideContext';
import './HelpGuide.css';

/* ─── SVG icons (module-level, stable identity) ─── */
const HelpIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const LayerIcon = ({ size = 14, strokeWidth = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
  </svg>
);

const AssistantAvatar = () => (
  <div className="guide-msg-avatar"><LayerIcon size={14} /></div>
);

/* ─── Helpers ─── */

const RECT_PADDING = 6;

function computePaddedRect(el) {
  const r = el.getBoundingClientRect();
  return {
    top: r.top - RECT_PADDING,
    left: r.left - RECT_PADDING,
    width: r.width + RECT_PADDING * 2,
    height: r.height + RECT_PADDING * 2,
    bottom: r.bottom + RECT_PADDING,
    right: r.right + RECT_PADDING,
  };
}

/* ═══════════════════════════════════════════
   Tour Overlay — backdrop + highlight ring
   ═══════════════════════════════════════════ */
function TourOverlay() {
  const { activeTour, currentStep, tourStepIndex, isStepPageMatch, advanceTour, endTour } = useGuide();
  const [targetRect, setTargetRect] = useState(null);
  const retryRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!activeTour || !currentStep || !isStepPageMatch) {
      setTargetRect(null);
      return;
    }

    let retryCount = 0;
    let clickCleanup = null;
    const isLastStep = tourStepIndex === activeTour.steps.length - 1;
    const canAutoSkip = currentStep.navigateTo && !isLastStep;
    // Cap retries: 20 (~4s) for auto-skip, 150 (~30s) otherwise
    const MAX_RETRIES = canAutoSkip ? 20 : 150;

    const findTarget = () => {
      const el = document.querySelector(currentStep.element);
      if (!el) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          if (canAutoSkip) advanceTour();
          return;
        }
        retryRef.current = setTimeout(findTarget, 200);
        return;
      }

      setTargetRect(computePaddedRect(el));

      if (el.getBoundingClientRect().top < 0 || el.getBoundingClientRect().bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      if (currentStep.clickAdvance) {
        const handler = () => advanceTour();
        el.addEventListener('click', handler, { once: true });
        clickCleanup = () => el.removeEventListener('click', handler);
      }
    };

    findTarget();

    // Throttled scroll/resize handler
    const updateRect = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const el = document.querySelector(currentStep.element);
        if (el) setTargetRect(computePaddedRect(el));
      });
    };

    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);

    return () => {
      clearTimeout(retryRef.current);
      cancelAnimationFrame(rafRef.current);
      if (clickCleanup) clickCleanup();
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [activeTour, currentStep, isStepPageMatch, tourStepIndex, advanceTour]);

  if (!activeTour || !currentStep || !isStepPageMatch || !targetRect) return null;

  const clipPath = `polygon(
    0% 0%, 0% 100%,
    ${targetRect.left}px 100%, ${targetRect.left}px ${targetRect.top}px,
    ${targetRect.right}px ${targetRect.top}px, ${targetRect.right}px ${targetRect.bottom}px,
    ${targetRect.left}px ${targetRect.bottom}px, ${targetRect.left}px 100%,
    100% 100%, 100% 0%
  )`;

  return (
    <div className="guide-tour-overlay">
      <div className="guide-tour-backdrop" style={{ clipPath }} onClick={endTour} />
      <div
        className="guide-tour-highlight"
        style={{
          position: 'fixed',
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height,
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════
   Chat Panel
   ═══════════════════════════════════════════ */
function ChatPanel() {
  const { t } = useTranslation();
  const {
    isOpen, closeGuide, messages, sendMessage, loading,
    suggestions, startTour, clearChat, activeTour, endTour,
  } = useGuide();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (isOpen && !activeTour) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen, activeTour]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleSuggestionClick = (suggestion) => sendMessage(suggestion);
  const handleTourClick = useCallback((tourId) => startTour(tourId), [startTour]);

  if (!isOpen) return null;

  return (
    <div className={`guide-panel ${activeTour ? 'guide-panel--touring' : ''}`}>
      {/* Header */}
      <div className="guide-panel-header">
        <div className="guide-panel-header-left">
          <div className="guide-panel-avatar"><LayerIcon size={20} /></div>
          <div>
            <h3 className="guide-panel-title">{t('help.guide.title')}</h3>
            <span className="guide-panel-subtitle">
              {activeTour ? t('help.guide.guiding') : t('help.guide.subtitle')}
            </span>
          </div>
        </div>
        <div className="guide-panel-header-actions">
          {activeTour && (
            <button className="guide-panel-end-tour" onClick={endTour}>
              {t('help.guide.stop')}
            </button>
          )}
          {!activeTour && messages.length > 0 && (
            <button className="guide-panel-clear" onClick={clearChat} aria-label="Clear chat" title="Clear chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          )}
          <button className="guide-panel-close" onClick={closeGuide} aria-label="Close help">
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="guide-panel-messages">
        {messages.length === 0 && (
          <div className="guide-panel-welcome">
            <div className="guide-panel-welcome-icon"><LayerIcon size={32} strokeWidth={1.5} /></div>
            <h4>{t('help.guide.welcome')}</h4>
            <p>{t('help.guide.welcomeText')}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`guide-msg guide-msg--${msg.role} ${msg.isTourStep ? 'guide-msg--tour-step' : ''}`}>
            {msg.role === 'assistant' && <AssistantAvatar />}
            <div className="guide-msg-content">
              <div className="guide-msg-text">{msg.text}</div>

              {msg.tourId && (
                <button className="guide-msg-tour-btn" onClick={() => handleTourClick(msg.tourId)}>
                  <PlayIcon /> {t('help.guide.showMe')}
                </button>
              )}

              {msg.role === 'assistant' && !msg.isTourStep && msg.suggestions?.length > 0 && i === messages.length - 1 && (
                <div className="guide-msg-suggestions">
                  {msg.suggestions.map((s, j) => (
                    <button key={j} className="guide-chip" onClick={() => handleSuggestionClick(s)}>{s}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="guide-msg guide-msg--assistant">
            <AssistantAvatar />
            <div className="guide-msg-content">
              <div className="guide-msg-typing"><span /><span /><span /></div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {messages.length === 0 && (
        <div className="guide-panel-suggestions">
          {suggestions.map((s, i) => (
            <button key={i} className="guide-chip guide-chip--initial" onClick={() => handleSuggestionClick(s)}>{s}</button>
          ))}
        </div>
      )}

      {!activeTour && (
        <form className="guide-panel-input" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('help.guide.placeholder')}
            disabled={loading}
            maxLength={500}
          />
          <button type="submit" disabled={!input.trim() || loading} aria-label="Send message">
            <SendIcon />
          </button>
        </form>
      )}
    </div>
  );
}

/* ─── Main HelpGuide ─── */
function HelpGuide() {
  const { isOpen, toggleOpen, activeTour } = useGuide();

  return (
    <>
      {!isOpen && !activeTour && (
        <button className="guide-fab" onClick={toggleOpen} aria-label="Open help guide" title="Need help?">
          <HelpIcon />
        </button>
      )}
      <ChatPanel />
      <TourOverlay />
    </>
  );
}

export default HelpGuide;
