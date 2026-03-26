import { useState, useRef, useEffect, useCallback } from 'react';
import { useGuide } from '../contexts/GuideContext';
import './HelpGuide.css';

/* ─── SVG icons ─── */
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

/* ═══════════════════════════════════════════
   Tour Overlay — just backdrop + highlight ring.
   All text/instructions live in the chat panel.
   ═══════════════════════════════════════════ */
function TourOverlay() {
  const { activeTour, currentStep, tourStepIndex, isStepPageMatch, advanceTour, endTour } = useGuide();
  const [targetRect, setTargetRect] = useState(null);
  const retryRef = useRef(null);

  useEffect(() => {
    if (!activeTour || !currentStep || !isStepPageMatch) {
      setTargetRect(null);
      return;
    }

    let retryCount = 0;
    const MAX_RETRIES = currentStep.navigateTo ? 15 : 50;

    const findTarget = () => {
      const el = document.querySelector(currentStep.element);
      if (!el) {
        retryCount++;
        if (retryCount >= MAX_RETRIES && currentStep.navigateTo) {
          advanceTour();
          return;
        }
        retryRef.current = setTimeout(findTarget, 200);
        return;
      }

      const rect = el.getBoundingClientRect();
      const padding = 6;
      setTargetRect({
        top: rect.top - padding,
        left: rect.left - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
        bottom: rect.bottom + padding,
        right: rect.right + padding,
      });

      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      if (currentStep.clickAdvance) {
        const handler = () => advanceTour();
        el.addEventListener('click', handler, { once: true });
        return () => el.removeEventListener('click', handler);
      }
    };

    findTarget();

    const updateRect = () => {
      const el = document.querySelector(currentStep.element);
      if (el) {
        const rect = el.getBoundingClientRect();
        const padding = 6;
        setTargetRect({
          top: rect.top - padding,
          left: rect.left - padding,
          width: rect.width + padding * 2,
          height: rect.height + padding * 2,
          bottom: rect.bottom + padding,
          right: rect.right + padding,
        });
      }
    };

    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);

    return () => {
      clearTimeout(retryRef.current);
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
      <div
        className="guide-tour-backdrop"
        style={{ clipPath }}
        onClick={endTour}
      />
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
   Chat Panel — the single source of all guidance.
   Tour steps render as special messages in the chat.
   ═══════════════════════════════════════════ */
function ChatPanel() {
  const {
    isOpen, setIsOpen, messages, sendMessage, loading,
    suggestions, startTour, clearChat, activeTour, endTour,
  } = useGuide();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when panel opens
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

  const handleSuggestionClick = (suggestion) => {
    sendMessage(suggestion);
  };

  const handleTourClick = useCallback((tourId) => {
    startTour(tourId);
  }, [startTour]);

  if (!isOpen) return null;

  const AssistantAvatar = () => (
    <div className="guide-msg-avatar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    </div>
  );

  return (
    <div className={`guide-panel ${activeTour ? 'guide-panel--touring' : ''}`}>
      {/* Header */}
      <div className="guide-panel-header">
        <div className="guide-panel-header-left">
          <div className="guide-panel-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <h3 className="guide-panel-title">Cellarion Guide</h3>
            <span className="guide-panel-subtitle">
              {activeTour ? activeTour.title : 'Ask anything about the app'}
            </span>
          </div>
        </div>
        <div className="guide-panel-header-actions">
          {activeTour && (
            <button className="guide-panel-end-tour" onClick={endTour}>
              End tour
            </button>
          )}
          {!activeTour && messages.length > 0 && (
            <button className="guide-panel-clear" onClick={clearChat} aria-label="Clear chat" title="Clear chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          )}
          <button className="guide-panel-close" onClick={() => { setIsOpen(false); if (activeTour) endTour(); }} aria-label="Close help">
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="guide-panel-messages">
        {messages.length === 0 && (
          <div className="guide-panel-welcome">
            <div className="guide-panel-welcome-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <h4>Welcome to Cellarion!</h4>
            <p>I can help you navigate the app, show you features, and walk you through anything step by step.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`guide-msg guide-msg--${msg.role} ${msg.isTourStep ? 'guide-msg--tour-step' : ''}`}>
            {msg.role === 'assistant' && <AssistantAvatar />}
            <div className="guide-msg-content">
              {/* Tour step badge */}
              {msg.isTourStep && (
                <span className="guide-msg-step-badge">{msg.stepLabel}</span>
              )}

              <div className="guide-msg-text">{msg.text}</div>

              {/* Click hint for tour steps */}
              {msg.isTourStep && msg.clickHint && i === messages.length - 1 && (
                <span className="guide-msg-click-hint">{msg.clickHint}</span>
              )}

              {/* "Show me how" button */}
              {msg.tourId && (
                <button
                  className="guide-msg-tour-btn"
                  onClick={() => handleTourClick(msg.tourId)}
                >
                  <PlayIcon /> Show me how
                </button>
              )}

              {/* Follow-up suggestions (only on latest non-tour message) */}
              {msg.role === 'assistant' && !msg.isTourStep && msg.suggestions?.length > 0 && i === messages.length - 1 && (
                <div className="guide-msg-suggestions">
                  {msg.suggestions.map((s, j) => (
                    <button key={j} className="guide-chip" onClick={() => handleSuggestionClick(s)}>
                      {s}
                    </button>
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

      {/* Quick suggestions (shown when chat is empty) */}
      {messages.length === 0 && (
        <div className="guide-panel-suggestions">
          {suggestions.map((s, i) => (
            <button key={i} className="guide-chip guide-chip--initial" onClick={() => handleSuggestionClick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input — hidden during tour, shown otherwise */}
      {!activeTour && (
        <form className="guide-panel-input" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask me anything..."
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
      {/* Floating help button — hidden when panel is open or tour is active */}
      {!isOpen && !activeTour && (
        <button className="guide-fab" onClick={toggleOpen} aria-label="Open help guide" title="Need help?">
          <HelpIcon />
        </button>
      )}

      {/* Chat panel — visible when open OR during a tour */}
      <ChatPanel />

      {/* Tour overlay — just the highlight, no popover */}
      <TourOverlay />
    </>
  );
}

export default HelpGuide;
