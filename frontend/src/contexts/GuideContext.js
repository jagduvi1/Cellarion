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
  // Trailing slash → contains match ('/bottles/' matches '/cellars/x/bottles/y')
  if (pattern.endsWith('/')) {
    return pathname.includes(pattern);
  }
  // No trailing slash → exact match OR suffix match
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
    // Steps marked noSkip require a prerequisite (e.g. opening a menu first)
    if (step.noSkip) continue;
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
  const tourRef = useRef(null);
  const lastAdvanceRef = useRef(0); // debounce guard

  // Keep tourRef in sync
  useEffect(() => {
    tourRef.current = activeTour ? { tour: activeTour, step: tourStepIndex } : null;
  }, [activeTour, tourStepIndex]);

  // Get suggestions for current page
  const suggestions = getSuggestionsForPage(location.pathname);

  // ─── Helpers ───

  /** Build a conversational chat message for a tour step. */
  function stepMessage(tour, index) {
    const step = tour.steps[index];
    return {
      role: 'assistant',
      isTourStep: true,
      text: step.description,
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
    const step = tour.steps[bestStart];
    const stepsRemaining = tour.steps.length - bestStart;

    // Auto-navigate if the chosen step requires it
    if (step.navigateTo && !location.pathname.startsWith(step.navigateTo)) {
      navigate(step.navigateTo);
    }

    // Single-step tours that just navigate + explain: show the message
    // but don't start a tour overlay — the chat message IS the help.
    if (stepsRemaining === 1 && !step.clickAdvance) {
      setIsOpen(true);
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          isTourStep: true,
          text: step.description,
        },
        {
          role: 'assistant',
          text: 'There you go! Is there anything else you\'d like help with?',
          suggestions: getSuggestionsForPage(step.navigateTo || location.pathname),
        },
      ]);
      return; // No overlay, no active tour
    }

    // Multi-step tour: activate the overlay
    setActiveTour(tour);
    setTourStepIndex(bestStart);
    setIsOpen(true);
    setMessages(prev => [
      ...prev,
      stepMessage(tour, bestStart),
    ]);
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
  
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'There you go! Is there anything else you\'d like help with?',
        suggestions: getSuggestionsForPage(location.pathname),
      }]);
      return;
    }

    setTourStepIndex(nextIndex);

    // Narrate the next step in chat
    setMessages(prev => [...prev, stepMessage(activeTour, nextIndex)]);

    // Auto-navigate if next step requires it
    const nextStep = activeTour.steps[nextIndex];
    if (nextStep.navigateTo && !location.pathname.startsWith(nextStep.navigateTo)) {
      navigate(nextStep.navigateTo);
    }
  }, [activeTour, tourStepIndex, location.pathname, navigate]);

  const endTour = useCallback(() => {
    if (activeTour) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'No problem! Let me know if you need anything else.',
        suggestions: getSuggestionsForPage(location.pathname),
      }]);
    }
    setActiveTour(null);
    setTourStepIndex(0);

  }, [activeTour, location.pathname]);

  // Watch for page changes during a tour — if the user navigated (or was
  // redirected) past the current step, auto-jump to the matching step.
  // This handles: only-one-cellar redirects, manual navigation, etc.
  useEffect(() => {
    if (!activeTour) return;
    const step = activeTour.steps[tourStepIndex];
    if (!step?.waitForPage) return;

    // Current step doesn't match the page we're on
    if (!matchesPage(step.waitForPage, location.pathname)) {
      // Look for a later step that matches
      for (let i = tourStepIndex + 1; i < activeTour.steps.length; i++) {
        const laterStep = activeTour.steps[i];
        if (laterStep.waitForPage && matchesPage(laterStep.waitForPage, location.pathname)) {
          setTourStepIndex(i);
          setMessages(prev => [...prev, stepMessage(activeTour, i)]);
          return;
        }
      }
    }
  }, [activeTour, tourStepIndex, location.pathname]);

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
