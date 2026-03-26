import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { askGuide as askGuideApi } from '../api/guide';
import TOURS, { getSuggestionsForPage, findFaqMatch } from '../utils/guideTours';

/**
 * Match a pathname against a waitForPage pattern.
 *   - Trailing slash → prefix match  ('/cellars/' matches '/cellars/123')
 *   - No trailing slash → exact match ('/cellars' matches only '/cellars')
 *     OR suffix match ('/add-bottle' matches '/cellars/123/add-bottle')
 */
function matchesPage(pattern, pathname) {
  if (!pattern) return true;
  if (pattern.endsWith('/')) {
    return pathname.startsWith(pattern);
  }
  return pathname === pattern || pathname.endsWith(pattern);
}

/**
 * Find the best starting step for a tour based on the user's current page.
 * Scans backwards from the last step and returns the index of the latest
 * step whose waitForPage matches — so we skip steps the user has already
 * navigated past.
 */
function findBestStartStep(tour, pathname) {
  for (let i = tour.steps.length - 1; i > 0; i--) {
    const step = tour.steps[i];
    if (step.waitForPage && matchesPage(step.waitForPage, pathname)) {
      return i;
    }
  }
  return 0;
}

const GuideContext = createContext(null);

export function useGuide() {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error('useGuide must be used within GuideProvider');
  return ctx;
}

export function GuideProvider({ children }) {
  const { apiFetch } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Chat state
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  // Tour state
  const [activeTour, setActiveTour] = useState(null);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourStartOffset, setTourStartOffset] = useState(0);
  const tourRef = useRef(null);
  const lastAdvanceRef = useRef(0); // debounce guard

  // Keep tourRef in sync
  useEffect(() => {
    tourRef.current = activeTour ? { tour: activeTour, step: tourStepIndex } : null;
  }, [activeTour, tourStepIndex]);

  // Get suggestions for current page
  const suggestions = getSuggestionsForPage(location.pathname);

  // ─── Helpers ───

  /** Build a chat message for a tour step with relative numbering. */
  function stepMessage(tour, index, offset) {
    const step = tour.steps[index];
    const visibleTotal = tour.steps.length - offset;
    const visibleNumber = index - offset + 1;
    return {
      role: 'assistant',
      isTourStep: true,
      stepLabel: visibleTotal > 1 ? `Step ${visibleNumber} of ${visibleTotal}` : null,
      text: step.description,
      clickHint: step.clickAdvance
        ? 'Click the highlighted element to continue.'
        : null,
    };
  }

  // ─── Chat ───

  const sendMessage = useCallback(async (question) => {
    if (!question.trim()) return;

    setMessages(prev => [...prev, { role: 'user', text: question }]);
    setLoading(true);

    try {
      const res = await askGuideApi(apiFetch, question, location.pathname);
      const data = await res.json();

      if (data.fallback) {
        const faq = findFaqMatch(question);
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: faq.message,
          tourId: faq.tourId,
          suggestions: faq.suggestions,
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: data.message,
          tourId: data.tourId,
          suggestions: data.suggestions,
        }]);
      }
    } catch {
      const faq = findFaqMatch(question);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: faq.message,
        tourId: faq.tourId,
        suggestions: faq.suggestions,
      }]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, location.pathname]);

  // ─── Tour engine ───

  const startTour = useCallback((tourId) => {
    const tour = TOURS[tourId];
    if (!tour) return;

    const bestStart = findBestStartStep(tour, location.pathname);

    setActiveTour(tour);
    setTourStepIndex(bestStart);
    setTourStartOffset(bestStart);

    // Open chat and narrate the first step
    setIsOpen(true);
    setMessages(prev => [
      ...prev,
      { role: 'assistant', text: `Let me walk you through: **${tour.title}**` },
      stepMessage(tour, bestStart, bestStart),
    ]);

    // Auto-navigate if the chosen step requires it
    const step = tour.steps[bestStart];
    if (step.navigateTo && !location.pathname.startsWith(step.navigateTo)) {
      navigate(step.navigateTo);
    }
  }, [location.pathname, navigate]);

  const advanceTour = useCallback(() => {
    if (!activeTour) return;
    // Debounce: ignore rapid duplicate calls (e.g. click handler + auto-advance)
    const now = Date.now();
    if (now - lastAdvanceRef.current < 400) return;
    lastAdvanceRef.current = now;

    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      // Tour complete
      setActiveTour(null);
      setTourStepIndex(0);
      setTourStartOffset(0);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'All done! You\'re all set. Is there anything else I can help with?',
        suggestions: getSuggestionsForPage(location.pathname),
      }]);
      return;
    }

    setTourStepIndex(nextIndex);

    // Narrate the next step in chat
    setMessages(prev => [...prev, stepMessage(activeTour, nextIndex, tourStartOffset)]);

    // Auto-navigate if next step requires it
    const nextStep = activeTour.steps[nextIndex];
    if (nextStep.navigateTo && !location.pathname.startsWith(nextStep.navigateTo)) {
      navigate(nextStep.navigateTo);
    }
  }, [activeTour, tourStepIndex, tourStartOffset, location.pathname, navigate]);

  const endTour = useCallback(() => {
    if (activeTour) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'Tour ended. Feel free to ask me anything else!',
        suggestions: getSuggestionsForPage(location.pathname),
      }]);
    }
    setActiveTour(null);
    setTourStepIndex(0);
    setTourStartOffset(0);
  }, [activeTour, location.pathname]);

  // Check if the current page matches the current step's waitForPage
  const currentStep = activeTour?.steps[tourStepIndex] ?? null;
  const isStepPageMatch = !currentStep?.waitForPage ||
    matchesPage(currentStep.waitForPage, location.pathname);

  const toggleOpen = useCallback(() => {
    setIsOpen(prev => !prev);
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
  }, []);

  const value = {
    // Chat
    isOpen,
    setIsOpen,
    toggleOpen,
    messages,
    sendMessage,
    loading,
    suggestions,
    clearChat,
    // Tour
    activeTour,
    currentStep,
    tourStepIndex,
    isStepPageMatch,
    startTour,
    advanceTour,
    endTour,
  };

  return (
    <GuideContext.Provider value={value}>
      {children}
    </GuideContext.Provider>
  );
}

export default GuideContext;
