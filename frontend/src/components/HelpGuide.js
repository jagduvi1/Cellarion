import { useState, useRef, useEffect, useCallback } from 'react';
import { useGuide } from '../contexts/GuideContext';
import './HelpGuide.css';

/* ─── SVG icons (inline to avoid extra deps) ─── */
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

/* ─── Tour Overlay ─── */
function TourOverlay() {
  const { activeTour, currentStep, tourStepIndex, isStepPageMatch, advanceTour, endTour } = useGuide();
  const [targetRect, setTargetRect] = useState(null);
  const [popoverSide, setPopoverSide] = useState('bottom');
  const retryRef = useRef(null);

  // Find and track the target element
  useEffect(() => {
    if (!activeTour || !currentStep || !isStepPageMatch) {
      setTargetRect(null);
      return;
    }

    let retryCount = 0;
    const MAX_RETRIES = 8; // ~1.6s before auto-advancing

    const findTarget = () => {
      const el = document.querySelector(currentStep.element);
      if (!el) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          // Element not on this page — auto-advance to next step
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

      // Determine popover placement
      const placement = currentStep.placement || 'bottom';
      setPopoverSide(placement);

      // Scroll into view if needed
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // If clickAdvance, listen for click on the element
      if (currentStep.clickAdvance) {
        const handler = () => {
          advanceTour();
        };
        el.addEventListener('click', handler, { once: true });
        return () => el.removeEventListener('click', handler);
      }
    };

    findTarget();

    // Update on scroll/resize
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

  // Calculate popover position
  const getPopoverStyle = () => {
    const gap = 12;
    const style = { position: 'fixed' };

    switch (popoverSide) {
      case 'top':
        style.bottom = `${window.innerHeight - targetRect.top + gap}px`;
        style.left = `${targetRect.left + targetRect.width / 2}px`;
        style.transform = 'translateX(-50%)';
        break;
      case 'left':
        style.top = `${targetRect.top + targetRect.height / 2}px`;
        style.right = `${window.innerWidth - targetRect.left + gap}px`;
        style.transform = 'translateY(-50%)';
        break;
      case 'right':
        style.top = `${targetRect.top + targetRect.height / 2}px`;
        style.left = `${targetRect.right + gap}px`;
        style.transform = 'translateY(-50%)';
        break;
      default: // bottom
        style.top = `${targetRect.bottom + gap}px`;
        style.left = `${targetRect.left + targetRect.width / 2}px`;
        style.transform = 'translateX(-50%)';
    }

    return style;
  };

  // Clip-path for dark overlay with cutout
  const clipPath = `polygon(
    0% 0%, 0% 100%,
    ${targetRect.left}px 100%, ${targetRect.left}px ${targetRect.top}px,
    ${targetRect.right}px ${targetRect.top}px, ${targetRect.right}px ${targetRect.bottom}px,
    ${targetRect.left}px ${targetRect.bottom}px, ${targetRect.left}px 100%,
    100% 100%, 100% 0%
  )`;

  const totalSteps = activeTour.steps.length;
  const isLastStep = tourStepIndex === totalSteps - 1;

  return (
    <div className="guide-tour-overlay">
      {/* Dark backdrop with cutout */}
      <div
        className="guide-tour-backdrop"
        style={{ clipPath }}
        onClick={endTour}
      />

      {/* Pulsing highlight ring */}
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

      {/* Step popover */}
      <div className="guide-tour-popover" style={getPopoverStyle()}>
        <div className="guide-tour-popover-header">
          <span className="guide-tour-step-badge">
            {tourStepIndex + 1} / {totalSteps}
          </span>
          <button className="guide-tour-close" onClick={endTour} aria-label="End tour">
            <CloseIcon />
          </button>
        </div>
        <h4 className="guide-tour-title">{currentStep.title}</h4>
        <p className="guide-tour-desc">{currentStep.description}</p>
        <div className="guide-tour-actions">
          <button className="guide-tour-btn-skip" onClick={endTour}>
            Skip
          </button>
          {!currentStep.clickAdvance && (
            <button className="guide-tour-btn-next" onClick={advanceTour}>
              {isLastStep ? 'Done' : 'Next'}
            </button>
          )}
          {currentStep.clickAdvance && (
            <span className="guide-tour-click-hint">
              Click the highlighted element to continue
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Chat Panel ─── */
function ChatPanel() {
  const {
    isOpen, setIsOpen, messages, sendMessage, loading,
    suggestions, startTour, clearChat,
  } = useGuide();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

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
    setIsOpen(false);
  }, [startTour, setIsOpen]);

  if (!isOpen) return null;

  return (
    <div className="guide-panel">
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
            <span className="guide-panel-subtitle">Ask anything about the app</span>
          </div>
        </div>
        <div className="guide-panel-header-actions">
          {messages.length > 0 && (
            <button className="guide-panel-clear" onClick={clearChat} aria-label="Clear chat" title="Clear chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          )}
          <button className="guide-panel-close" onClick={() => setIsOpen(false)} aria-label="Close help">
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
          <div key={i} className={`guide-msg guide-msg--${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="guide-msg-avatar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                </svg>
              </div>
            )}
            <div className="guide-msg-content">
              <div className="guide-msg-text">{msg.text}</div>

              {/* Show me button for tours */}
              {msg.tourId && (
                <button
                  className="guide-msg-tour-btn"
                  onClick={() => handleTourClick(msg.tourId)}
                >
                  <PlayIcon /> Show me how
                </button>
              )}

              {/* Follow-up suggestions */}
              {msg.role === 'assistant' && msg.suggestions?.length > 0 && i === messages.length - 1 && (
                <div className="guide-msg-suggestions">
                  {msg.suggestions.map((s, j) => (
                    <button
                      key={j}
                      className="guide-chip"
                      onClick={() => handleSuggestionClick(s)}
                    >
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
            <div className="guide-msg-avatar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="guide-msg-content">
              <div className="guide-msg-typing">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick suggestions (shown when chat is empty) */}
      {messages.length === 0 && (
        <div className="guide-panel-suggestions">
          {suggestions.map((s, i) => (
            <button
              key={i}
              className="guide-chip guide-chip--initial"
              onClick={() => handleSuggestionClick(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
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
        <button
          type="submit"
          disabled={!input.trim() || loading}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

/* ─── Main HelpGuide ─── */
function HelpGuide() {
  const { isOpen, toggleOpen, activeTour } = useGuide();

  return (
    <>
      {/* Floating help button */}
      {!isOpen && !activeTour && (
        <button
          className="guide-fab"
          onClick={toggleOpen}
          aria-label="Open help guide"
          title="Need help?"
        >
          <HelpIcon />
        </button>
      )}

      {/* Chat panel */}
      <ChatPanel />

      {/* Tour overlay */}
      <TourOverlay />
    </>
  );
}

export default HelpGuide;
