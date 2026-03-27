import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { askGuide as askGuideApi } from '../api/guide';
import TOURS, { getSuggestionsForPage, findFaqMatch } from '../utils/guideTours';

/**
 * Match a pathname against a waitForPage pattern.
 *   - Trailing slash → contains match ('/bottles/' matches '/cellars/x/bottles/y')
 *   - No trailing slash → exact or suffix match
 */
function matchesPage(pattern, pathname) {
  if (!pattern) return true;
  if (pattern.endsWith('/')) return pathname.includes(pattern);
  return pathname === pattern || pathname.endsWith(pattern);
}

/**
 * Find the best starting step based on current page.
 * Scans backwards, skips noSkip steps, verifies element exists in DOM.
 */
function findBestStartStep(tour, pathname) {
  for (let i = tour.steps.length - 1; i > 0; i--) {
    const step = tour.steps[i];
    if (step.noSkip) continue;
    if (step.waitForPage && matchesPage(step.waitForPage, pathname)) {
      if (document.querySelector(step.element)) return i;
    }
  }
  return 0;
}

/** Resolve a FAQ result's i18n keys. */
function resolveFaq(faq, t) {
  return {
    role: 'assistant',
    text: t(faq.messageKey),
    tourId: faq.tourId,
    suggestions: faq.suggestionKeys.map(k => t(k)),
  };
}

const GuideContext = createContext(null);

export function useGuide() {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error('useGuide must be used within GuideProvider');
  return ctx;
}

export function GuideProvider({ children }) {
  const { apiFetch } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTour, setActiveTour] = useState(null);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const lastAdvanceRef = useRef(0);

  const suggestions = useMemo(
    () => getSuggestionsForPage(location.pathname).map(key => t(key)),
    [location.pathname, t]
  );

  function resolvedSuggestions(pathname) {
    return getSuggestionsForPage(pathname).map(k => t(k));
  }

  function stepMessage(tour, index) {
    const step = tour.steps[index];
    return { role: 'assistant', isTourStep: true, text: step.descKey ? t(step.descKey) : step.description };
  }

  const sendMessage = useCallback(async (question) => {
    if (!question.trim()) return;
    setMessages(prev => [...prev, { role: 'user', text: question }]);
    setLoading(true);

    try {
      const res = await askGuideApi(apiFetch, question, location.pathname);
      const data = await res.json();

      if (data.fallback) {
        setMessages(prev => [...prev, resolveFaq(findFaqMatch(question), t)]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: data.message,
          tourId: data.tourId,
          suggestions: data.suggestions,
        }]);
      }
    } catch {
      setMessages(prev => [...prev, resolveFaq(findFaqMatch(question), t)]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, location.pathname, t]);

  const startTour = useCallback((tourId) => {
    const tour = TOURS[tourId];
    if (!tour) return;

    const bestStart = findBestStartStep(tour, location.pathname);
    const step = tour.steps[bestStart];

    if (step.navigateTo && !location.pathname.startsWith(step.navigateTo)) {
      navigate(step.navigateTo);
    }

    setActiveTour(tour);
    setTourStepIndex(bestStart);
    setIsOpen(true);
    setMessages(prev => [...prev, stepMessage(tour, bestStart)]);
  }, [location.pathname, navigate, t]);

  const advanceTour = useCallback(() => {
    if (!activeTour) return;
    const now = Date.now();
    if (now - lastAdvanceRef.current < 400) return;
    lastAdvanceRef.current = now;

    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      setActiveTour(null);
      setTourStepIndex(0);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: t('help.tour.done'),
        suggestions: resolvedSuggestions(location.pathname),
      }]);
      return;
    }

    setTourStepIndex(nextIndex);
    setMessages(prev => [...prev, stepMessage(activeTour, nextIndex)]);

    const nextStep = activeTour.steps[nextIndex];
    if (nextStep.navigateTo && !location.pathname.startsWith(nextStep.navigateTo)) {
      navigate(nextStep.navigateTo);
    }
  }, [activeTour, tourStepIndex, location.pathname, navigate, t]);

  const endTour = useCallback(() => {
    if (activeTour) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: t('help.tour.stopped'),
        suggestions: resolvedSuggestions(location.pathname),
      }]);
    }
    setActiveTour(null);
    setTourStepIndex(0);
  }, [activeTour, location.pathname, t]);

  const closeGuide = useCallback(() => {
    setIsOpen(false);
    if (activeTour) {
      setActiveTour(null);
      setTourStepIndex(0);
    }
  }, [activeTour]);

  const toggleOpen = useCallback(() => setIsOpen(prev => !prev), []);
  const clearChat = useCallback(() => setMessages([]), []);

  // Auto-jump when page changes during tour
  useEffect(() => {
    if (!activeTour) return;
    const step = activeTour.steps[tourStepIndex];
    if (!step?.waitForPage) return;

    if (!matchesPage(step.waitForPage, location.pathname)) {
      for (let i = tourStepIndex + 1; i < activeTour.steps.length; i++) {
        const laterStep = activeTour.steps[i];
        if (laterStep.noSkip) continue;
        if (laterStep.waitForPage && matchesPage(laterStep.waitForPage, location.pathname)) {
          setTourStepIndex(i);
          setMessages(prev => [...prev, stepMessage(activeTour, i)]);
          return;
        }
      }
    }
  }, [activeTour, tourStepIndex, location.pathname, t]);

  const currentStep = activeTour?.steps[tourStepIndex] ?? null;
  const isStepPageMatch = !currentStep?.waitForPage ||
    matchesPage(currentStep.waitForPage, location.pathname);

  const value = useMemo(() => ({
    isOpen, toggleOpen, closeGuide,
    messages, sendMessage, loading, suggestions, clearChat,
    activeTour, currentStep, tourStepIndex, isStepPageMatch,
    startTour, advanceTour, endTour,
  }), [
    isOpen, toggleOpen, closeGuide,
    messages, sendMessage, loading, suggestions, clearChat,
    activeTour, currentStep, tourStepIndex, isStepPageMatch,
    startTour, advanceTour, endTour,
  ]);

  return (
    <GuideContext.Provider value={value}>
      {children}
    </GuideContext.Provider>
  );
}

export default GuideContext;
