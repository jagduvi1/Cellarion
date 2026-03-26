import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { askGuide as askGuideApi } from '../api/guide';
import TOURS, { getSuggestionsForPage, findFaqMatch } from '../utils/guideTours';

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
  const tourRef = useRef(null); // Ref for stable access in event handlers

  // Keep tourRef in sync
  useEffect(() => {
    tourRef.current = activeTour ? { tour: activeTour, step: tourStepIndex } : null;
  }, [activeTour, tourStepIndex]);

  // Get suggestions for current page
  const suggestions = getSuggestionsForPage(location.pathname);

  // ─── Chat ───

  const sendMessage = useCallback(async (question) => {
    if (!question.trim()) return;

    // Add user message
    setMessages(prev => [...prev, { role: 'user', text: question }]);
    setLoading(true);

    try {
      const res = await askGuideApi(apiFetch, question, location.pathname);
      const data = await res.json();

      if (data.fallback) {
        // AI unavailable — use local FAQ
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
      // Network error — use local FAQ
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

    setActiveTour(tour);
    setTourStepIndex(0);

    // Auto-navigate if first step has navigateTo
    const firstStep = tour.steps[0];
    if (firstStep.navigateTo && !location.pathname.startsWith(firstStep.navigateTo)) {
      navigate(firstStep.navigateTo);
    }
  }, [location.pathname, navigate]);

  const advanceTour = useCallback(() => {
    if (!activeTour) return;
    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      // Tour complete
      setActiveTour(null);
      setTourStepIndex(0);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'Tour complete! You\'re all set. Is there anything else I can help you with?',
        suggestions: getSuggestionsForPage(location.pathname),
      }]);
      return;
    }

    setTourStepIndex(nextIndex);

    // Auto-navigate if next step requires it
    const nextStep = activeTour.steps[nextIndex];
    if (nextStep.navigateTo && !location.pathname.startsWith(nextStep.navigateTo)) {
      navigate(nextStep.navigateTo);
    }
  }, [activeTour, tourStepIndex, location.pathname, navigate]);

  const endTour = useCallback(() => {
    setActiveTour(null);
    setTourStepIndex(0);
  }, []);

  // Check if the current page matches the current step's waitForPage
  const currentStep = activeTour?.steps[tourStepIndex] ?? null;
  const isStepPageMatch = !currentStep?.waitForPage ||
    location.pathname.includes(currentStep.waitForPage);

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
